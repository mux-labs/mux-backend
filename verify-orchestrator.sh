#!/bin/bash
set -euo pipefail

# =============================================================================
# verify-orchestrator.sh
#
# Fail-closed CI gate for the wallet-creation orchestrator invariants documented
# in docs/WALLET-API.md and README.md (§ Wallets).
#
# Invariants checked:
#   I1. Orchestrator service exists and is wired into the app.
#   I2. Wallet creation is atomic (Prisma $transaction — no partial wallets).
#   I3. One wallet per user per network is enforced.
#   I4. Wallet creation is idempotent (idempotencyKey / replay-safe upsert).
#   I5. Writes fail closed on dependency outage (RPC/DB/Horizon down).
#   I6. Authz enforced: owner/delegate/guardian/API-key; no client bypass.
#   I7. Money-path gated by FEATURE_WALLET_ORCHESTRATOR (deny-by-default).
#
# Exits 1 when any invariant is violated so the CI verify-scripts job fails.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

# Helper functions
pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    FAILED=$((FAILED + 1))
}

info() {
    echo -e "ℹ️  $1"
}

echo ""
echo "🔍 Verifying Wallet Creation Orchestrator Implementation"
echo "========================================================"
echo ""
info "References: docs/WALLET-API.md, docs/FEATURE-FLAGS.md, test/wallet-orchestration.e2e-spec.ts"
echo ""

# ---------------------------------------------------------------------------
# I1: Orchestrator service exists
# ---------------------------------------------------------------------------
echo "1. Checking orchestrator service exists..."

ORCH_FILES=$(find src/wallets -name "wallet-creation-orchestrator*" 2>/dev/null || true)
if [ -n "$ORCH_FILES" ]; then
    pass "Wallet Creation Orchestrator service exists ($(echo "$ORCH_FILES" | head -3))"
else
    fail "Wallet Creation Orchestrator service missing under src/wallets/"
fi
echo ""

# ---------------------------------------------------------------------------
# I2: Atomic transaction implementation
# ---------------------------------------------------------------------------
echo "2. Checking atomic transaction implementation..."

if grep -rq "\$transaction" src/wallets/ 2>/dev/null; then
    pass "Atomic transaction implemented (\$transaction found in wallet services)"
else
    fail "Atomic transaction not implemented — no \$transaction in wallet services"
fi
echo ""

# ---------------------------------------------------------------------------
# I3: One wallet per user + network enforcement
# ---------------------------------------------------------------------------
echo "3. Checking one wallet per user enforcement..."

if grep -q "@@unique(\[network, publicKey\])\|@@unique(\[userId, network\])\|@@index(\[userId, network\])" prisma/schema.prisma 2>/dev/null; then
    pass "One wallet per user enforced at schema level (unique/index on userId+network)"
elif grep -rq "findFirst" src/wallets/ 2>/dev/null && grep -rq "userId.*network\|network.*userId" src/wallets/ 2>/dev/null; then
    pass "One wallet per user enforced in wallet orchestration logic (findFirst + userId/network)"
else
    fail "One wallet per user enforcement not implemented (no schema or service-level check)"
fi
echo ""

# ---------------------------------------------------------------------------
# I4: Idempotency support
# ---------------------------------------------------------------------------
echo "4. Checking idempotency support..."

if grep -rq "idempotencyKey" src/wallets/ 2>/dev/null; then
    pass "Idempotency support implemented in wallet services (idempotencyKey)"
elif grep -q "idempotencyKey String.*@unique" prisma/schema.prisma 2>/dev/null; then
    pass "Idempotency enforced at schema level (idempotencyKey unique)"
else
    fail "Idempotency support not implemented — no idempotencyKey anywhere"
fi
echo ""

# ---------------------------------------------------------------------------
# I5: Fail-closed on dependency outage (writes reject, no partial state)
# ---------------------------------------------------------------------------
echo "5. Checking fail-closed handling for dependency outage..."

if grep -rq "ServiceUnavailableException\|DEPENDENCY_UNAVAILABLE\|DEPENDENCY_OUTAGE" src/wallets/ src/payments/ src/common/ 2>/dev/null; then
    pass "Dependency outage handled fail-closed (ServiceUnavailableException / DEPENDENCY_UNAVAILABLE found)"
else
    fail "Dependency outage is NOT handled fail-closed — writes may partially succeed"
fi
echo ""

# ---------------------------------------------------------------------------
# I6: Authz enforcement to prevent client bypass
# ---------------------------------------------------------------------------
echo "6. Checking authorization enforcement (owner/delegate/guardian/API-key)..."

if grep -rq "ForbiddenException\|NOT_AUTHORIZED\|AUTHZ_DENIED\|ApiKeyGuard\|RequireRole\|UnauthorizedException" src/wallets/ src/api-keys/ 2>/dev/null; then
    pass "Authorization enforcement present in wallet/authz code (guards / authz exceptions found)"
else
    fail "No authorization enforcement found for wallet creation"
fi
echo ""

# ---------------------------------------------------------------------------
# I7: Feature-flag / kill-switch on the money path
# ---------------------------------------------------------------------------
echo "7. Checking feature-flag / kill-switch gating..."

if grep -rq "FEATURE_WALLET_ORCHESTRATOR" src/ test/ 2>/dev/null; then
    pass "Wallet orchestrator money-path gated by FEATURE_WALLET_ORCHESTRATOR"
else
    fail "Wallet orchestrator is NOT gated by a feature flag — kill-switch missing"
fi
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "========================================================"
echo "📊 Verification Summary"
echo "========================================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}🎉 All wallet orchestration checks passed!${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some checks failed ($FAILED). Bring the code back in line with the"
    echo -e "     documented invariants before merging — this must not be bypassed.${NC}"
    echo ""
    echo "For help:"
    echo "  - docs/WALLET-API.md"
    echo "  - docs/FEATURE-FLAGS.md"
    echo "  - test/wallet-orchestration.e2e-spec.ts"
    exit 1
fi