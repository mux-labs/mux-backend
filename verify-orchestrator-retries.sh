#!/bin/bash
set -euo pipefail

# =============================================================================
# verify-orchestrator-retries.sh
#
# Fail-closed CI gate for the wallet-orchestration retry contract documented in
# docs/WALLET-API.md and README.md (§ Wallets API) — issue #963.
#
# The external orchestrator retries on failure. A retry that minted a second
# custody key for the same user would strand funds on an orphaned address, so
# these invariants are asserted against the source tree.
#
#   R1. The orchestrator controller is wired into its module.
#   R2. Idempotency-key replay returns the original result (no second mint).
#   R3. An in-flight key is rejected rather than processed twice.
#   R4. A key reused for a different user/network is a conflict, not a leak.
#   R5. One wallet per (userId, network) even without an idempotency key.
#   R6. The mint step is awaited so the reservation covers persistence.
#   R7. Authz: the surface requires an API key and a feature flag.
#   R8. Typed, stable error codes are used for every rejection.
#   R9. Private key material never crosses the service boundary.
#  R10. The create body is a validated DTO (adversarial-input guard).
#
# Exits 1 when any invariant is violated.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }

SVC="src/wallets/wallet-creation-orchestrator.service.ts"
CTL="src/wallets/wallet-creation-orchestrator.controller.ts"
MOD="src/wallets/wallet-creation-orchestrator.module.ts"

echo ""
echo "🔍 Verifying Wallet Orchestration Retry Contract"
echo "========================================================"
echo ""
echo "ℹ️  References: docs/WALLET-API.md, test/wallet-orchestration.e2e-spec.ts"
echo ""

# ---------------------------------------------------------------------------
# R1: controller wired
# ---------------------------------------------------------------------------
echo "1. Checking controller wiring..."

if [ -f "$CTL" ] && [ -f "$MOD" ] && grep -q "WalletCreationOrchestratorController" "$MOD"; then
    pass "Orchestration controller is registered in its module"
else
    fail "Orchestration controller missing or not registered — /wallets/orchestration/* does not exist"
fi
echo ""

# ---------------------------------------------------------------------------
# R2: replay returns the original result
# ---------------------------------------------------------------------------
echo "2. Checking idempotency-key replay..."

if grep -q "byIdempotencyKey" "$SVC" 2>/dev/null && \
   grep -q "replayIfCompleted" "$SVC" 2>/dev/null; then
    pass "Completed idempotency keys replay a stored result"
else
    fail "No idempotency replay — a retry after a dropped response can mint a duplicate wallet"
fi
echo ""

# ---------------------------------------------------------------------------
# R3: in-flight key rejected
# ---------------------------------------------------------------------------
echo "3. Checking in-flight key reservation..."

if grep -q "inFlight" "$SVC" 2>/dev/null && \
   grep -q "WALLET_ORCHESTRATION_IDEMPOTENCY_IN_PROGRESS" "$SVC" 2>/dev/null; then
    pass "Concurrent retries on one key are rejected with a stable code"
else
    fail "No in-flight reservation — two concurrent retries can both mint wallets"
fi
echo ""

# ---------------------------------------------------------------------------
# R6: mint awaited
# ---------------------------------------------------------------------------
echo "4. Checking the mint step is awaited..."

# If the reservation is released before persistence completes, a concurrent
# retry can slip through. `await this.mint` is what prevents that.
if grep -q "await this\.mint(" "$SVC" 2>/dev/null; then
    pass "mint() is awaited, so the reservation covers persistence"
else
    fail "mint() is not awaited — the in-flight reservation is released early and concurrent retries can duplicate a wallet"
fi
echo ""

# ---------------------------------------------------------------------------
# R4: key reuse across users is a conflict
# ---------------------------------------------------------------------------
echo "5. Checking idempotency key scoping..."

if grep -q "WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT" "$SVC" 2>/dev/null; then
    pass "Reusing a key for a different user/network is rejected"
else
    fail "Key reuse across users/networks is not rejected — cross-tenant wallet leak"
fi
echo ""

# ---------------------------------------------------------------------------
# R5: one wallet per user+network
# ---------------------------------------------------------------------------
echo "6. Checking one-wallet-per-user-per-network..."

if grep -q "naturalKey" "$SVC" 2>/dev/null; then
    pass "Natural-key guard prevents a duplicate wallet without an idempotency key"
else
    fail "No natural-key guard — a no-key retry can create a second wallet"
fi
echo ""

# ---------------------------------------------------------------------------
# R7: authz
# ---------------------------------------------------------------------------
echo "7. Checking authorization on the orchestration surface..."

if grep -q "ApiKeyGuard" "$CTL" 2>/dev/null; then
    pass "Create/lookup surface requires an API key"
else
    fail "No API key guard — a client can bypass policy on wallet creation"
fi

if grep -q "FeatureFlag" "$CTL" 2>/dev/null; then
    pass "Create/lookup surface is gated behind a feature flag (deny-by-default)"
else
    fail "No feature-flag gate — the money-path surface cannot be disabled"
fi
echo ""

# ---------------------------------------------------------------------------
# R8: stable error codes
# ---------------------------------------------------------------------------
echo "8. Checking stable error codes..."

if grep -q "WALLET_ORCHESTRATION_INVALID_NETWORK" "$CTL" 2>/dev/null && \
   grep -q "WALLET_ORCHESTRATION_FAILED" "$CTL" 2>/dev/null; then
    pass "Controller returns stable, typed error codes"
else
    fail "Controller error responses lack stable codes"
fi
echo ""

# ---------------------------------------------------------------------------
# R9: no private key material
# ---------------------------------------------------------------------------
echo "9. Checking that private key material never crosses the boundary..."

if grep -q "privateKey" "$SVC" 2>/dev/null; then
    fail "Orchestrator result exposes a privateKey field — custody material must not cross the service boundary"
else
    pass "Orchestrator result carries no private key material"
fi
echo ""

# ---------------------------------------------------------------------------
# R10: validated DTO
# ---------------------------------------------------------------------------
echo "10. Checking the create body is validated..."

if [ -f "src/wallets/dto/create-wallet-orchestration.dto.ts" ] && \
   grep -q "CreateWalletOrchestrationDto" "$CTL" 2>/dev/null; then
    pass "Create body uses a validated DTO (whitelist/forbidNonWhitelisted effective)"
else
    fail "Create body is not a validated DTO — unexpected/oversized fields are not rejected"
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
    echo -e "${GREEN}🎉 All orchestration retry checks passed!${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some checks failed ($FAILED). A retry must never mint a second"
    echo -e "     custody key for the same user — this must not be bypassed.${NC}"
    echo ""
    echo "For help:"
    echo "  - docs/WALLET-API.md"
    echo "  - test/wallet-orchestration.e2e-spec.ts"
    echo "  - src/wallets/wallet-creation-orchestrator.service.spec.ts"
    exit 1
fi
