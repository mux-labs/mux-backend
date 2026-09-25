#!/bin/bash
set -euo pipefail

# =============================================================================
# verify-idempotency-ttl.sh
#
# Fail-closed CI gate for the idempotency TTL invariants documented in
# docs/IDEMPOTENCY-TTL.md and README.md (§ Idempotency TTL Cleanup).
#
# Invariants checked:
#   I1. Cleanup implementation exists and is wired into AppModule.
#   I2. Only strictly-expired rows are deleted (expiresAt < now, never <=).
#   I3. Batches are bounded (a maximum batch size is enforced).
#   I4. Dependency outage fails closed with a stable error code.
#   I5. Invalid batch size is rejected before any query is issued.
#   I6. The worker is deny-by-default (opt-in via an enable flag).
#   I7. The cleanup worker is NOT a public module export.
#   I8. Returned/logged values carry counts and cutoffs only — no key material.
#
# Dependency-free (plain bash + static analysis) so it cannot be skipped by a
# broken service step. Exits 1 when any invariant is violated.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    FAILED=$((FAILED + 1))
}

echo ""
echo "🔍 Verifying Idempotency TTL Cleanup"
echo "============================================="
echo ""
echo "ℹ️  References: docs/IDEMPOTENCY-TTL.md, README.md (§ Idempotency TTL Cleanup)"
echo ""

# ---------------------------------------------------------------------------
# I1: Cleanup implementation exists and is wired into AppModule
# ---------------------------------------------------------------------------
echo "1. Checking cleanup implementation and wiring..."

if [ -f "src/idempotency/idempotency.service.ts" ] && \
   [ -f "src/idempotency/idempotency-cleanup.worker.ts" ] && \
   [ -f "src/idempotency/idempotency.module.ts" ]; then
    pass "Idempotency cleanup service, worker, and module exist"
else
    fail "Idempotency cleanup service/worker/module missing"
fi

if grep -q "IdempotencyModule" src/app.module.ts 2>/dev/null; then
    pass "IdempotencyModule is registered in AppModule"
else
    fail "IdempotencyModule is NOT registered in AppModule — cleanup never runs"
fi
echo ""

# ---------------------------------------------------------------------------
# I2: Only strictly-expired rows are deleted
# ---------------------------------------------------------------------------
echo "2. Checking that only expired rows are deleted..."

# The query must use a strict `lt` on expiresAt. A `lte` would delete a record
# whose TTL has not elapsed, re-opening the duplicate-write window.
if grep -q 'expiresAt: { lt:' src/idempotency/idempotency.service.ts 2>/dev/null; then
    pass "Cleanup deletes only strictly-expired rows (expiresAt < now)"
else
    fail "Cleanup must delete only strictly-expired rows (expiresAt: { lt: ... })"
fi

if grep -q 'expiresAt: { lte:' src/idempotency/idempotency.service.ts 2>/dev/null; then
    fail "Cleanup uses lte on expiresAt — can delete a record whose TTL has not elapsed"
else
    pass "No lte comparison on expiresAt (live records are never touched)"
fi
echo ""

# ---------------------------------------------------------------------------
# I3: Batches are bounded
# ---------------------------------------------------------------------------
echo "3. Checking that cleanup batches are bounded..."

if grep -q 'MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE' src/idempotency/idempotency.service.ts 2>/dev/null && \
   grep -q 'Math.min' src/idempotency/idempotency.service.ts 2>/dev/null; then
    pass "Cleanup batch size is clamped to a documented maximum"
else
    fail "Cleanup batch size is NOT clamped — an unbounded DELETE can block writes"
fi
echo ""

# ---------------------------------------------------------------------------
# I4: Dependency outage fails closed with a stable error code
# ---------------------------------------------------------------------------
echo "4. Checking fail-closed handling for database outage..."

if grep -q 'IDEMPOTENCY_CLEANUP_DEPENDENCY_UNAVAILABLE' src/idempotency/idempotency.service.ts 2>/dev/null; then
    pass "Database outage fails closed with a stable error code"
else
    fail "Database outage does NOT fail closed — a swallowed outage looks like a healthy no-op"
fi

if grep -q 'IDEMPOTENCY_CLEANUP_INVALID_BATCH_SIZE' src/idempotency/idempotency.service.ts 2>/dev/null; then
    pass "Invalid batch size rejected with a stable error code"
else
    fail "Invalid batch size is NOT rejected with a stable error code"
fi
echo ""

# ---------------------------------------------------------------------------
# I5/I6: deny-by-default worker
# ---------------------------------------------------------------------------
echo "5. Checking the worker is deny-by-default (opt-in)..."

if grep -q "IDEMPOTENCY_CLEANUP_ENABLED" src/idempotency/idempotency-cleanup.worker.ts 2>/dev/null; then
    pass "In-process worker is gated behind IDEMPOTENCY_CLEANUP_ENABLED"
else
    fail "Worker has no enable flag — cleanup cannot be turned off for scheduler-based deployments"
fi
echo ""

# ---------------------------------------------------------------------------
# I7: worker is not a public export
# ---------------------------------------------------------------------------
echo "6. Checking the cleanup worker is not a public module export..."

if grep -q 'exports: \[IdempotencyService\]' src/idempotency/idempotency.module.ts 2>/dev/null; then
    pass "IdempotencyModule exports only IdempotencyService (worker stays internal)"
else
    fail "IdempotencyModule exports more than IdempotencyService — the worker should stay internal"
fi
echo ""

# ---------------------------------------------------------------------------
# I8: no secret material in the cleanup surface
# ---------------------------------------------------------------------------
echo "7. Checking that cleanup never logs key material..."

# Idempotency keys and cached response payloads must not be logged. The service
# may reference them in code, but must not log a `response` or a raw `key`.
if grep -rn 'logger\..*\.key\b\|logger\..*\.response\b' src/idempotency/ 2>/dev/null; then
    fail "Cleanup logs an idempotency key or cached response — redact before logging"
else
    pass "Cleanup logs counts and cutoffs only, never keys or cached payloads"
fi
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "============================================="
echo "📊 Verification Summary"
echo "============================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}🎉 All idempotency TTL checks passed!${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some checks failed ($FAILED). Cleanup must not be able to delete a"
    echo -e "     live record or mask a database outage — this must not be bypassed.${NC}"
    echo ""
    echo "For help:"
    echo "  - docs/IDEMPOTENCY-TTL.md"
    echo "  - README.md (§ Idempotency TTL Cleanup)"
    exit 1
fi
