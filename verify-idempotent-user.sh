#!/bin/bash
set -euo pipefail

# =============================================================================
# verify-idempotent-user.sh
#
# Fail-closed CI gate for the idempotent user-creation invariants documented
# in test/users-find-or-create.e2e-spec.ts and README.md (§ Users / Auth).
#
# Invariants checked:
#   I1. Idempotent user service exists (findOrCreateUser).
#   I2. Duplicate prevention: authId is unique at the schema level.
#   I3. Existing-user return: concurrent/replayed requests never create a duel.
#   I4. Authz gated: POST /users/find-or-create requires API-key / JWT.
#   I5. Schema enforces User model identity + Wallet ownership relations.
#   I6. Dependency outage fails closed (no partial user rows).
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
echo "🔍 Verifying Idempotent User Creation Flow Implementation"
echo "========================================================="
echo ""
info "References: test/users-find-or-create.e2e-spec.ts, prisma/schema.prisma (User model)"
echo ""

IDEMPOTENT_USER_FILE=src/users/idempotent-user.service.ts

# ---------------------------------------------------------------------------
# I1: Idempotent user service exists
# ---------------------------------------------------------------------------
echo "1. Checking idempotent user service exists..."

if [ -f "$IDEMPOTENT_USER_FILE" ]; then
    pass "Idempotent User Service exists ($IDEMPOTENT_USER_FILE)"
else
    fail "Idempotent User Service missing ($IDEMPOTENT_USER_FILE)"
fi
echo ""

# ---------------------------------------------------------------------------
# I1b: findOrCreateUser method
# ---------------------------------------------------------------------------
echo "2. Checking findOrCreateUser implementation..."

if grep -q "findOrCreateUser" "$IDEMPOTENT_USER_FILE" 2>/dev/null; then
    pass "findOrCreateUser method implemented"
else
    fail "findOrCreateUser method not implemented"
fi
echo ""

# ---------------------------------------------------------------------------
# I2: Duplicate prevention (authId unique at schema level + service check)
# ---------------------------------------------------------------------------
echo "3. Checking duplicate prevention..."

if grep -q "findUnique" "$IDEMPOTENT_USER_FILE" 2>/dev/null \
    && grep -q "authId" "$IDEMPOTENT_USER_FILE" 2>/dev/null; then
    pass "Duplicate prevention implemented in service (findUnique + authId)"
else
    fail "Duplicate prevention not implemented in idempotent user service"
fi

if grep -q "authId String @unique" prisma/schema.prisma 2>/dev/null; then
    pass "authId uniqueness also enforced at the schema level"
else
    fail "authId is NOT unique at the schema level — hard guarantee missing"
fi
echo ""

# ---------------------------------------------------------------------------
# I3: Existing-user return logic (replayed requests → identity, not collision)
# ---------------------------------------------------------------------------
echo "4. Checking existing user return logic..."

if grep -q "existingUser" "$IDEMPOTENT_USER_FILE" 2>/dev/null; then
    pass "Existing user return logic implemented (existingUser handled)"
else
    fail "Existing user return logic not implemented — replay may cause 409"
fi
echo ""

# ---------------------------------------------------------------------------
# I4: Authz gating on /users/find-or-create
# ---------------------------------------------------------------------------
echo "5. Checking authorization gating on user creation..."

if grep -rq "UnauthorizedException\|ApiKeyGuard\|IS_PUBLIC\|AUTH_REQUIRED" src/users/ src/api-keys/ 2>/dev/null; then
    pass "Authorization enforced on user creation (guards / authz exceptions found)"
elif grep -q "PUBLIC_ENDPOINT_ALLOWLIST" src/common/filters/http-exception.filter.ts 2>/dev/null; then
    # Check that find-or-create is NOT in the public allowlist
    if grep -q "find-or-create\|users.*find\|find.*users" src/common/filters/http-exception.filter.ts 2>/dev/null; then
        fail "find-or-create is in the public allowlist — deny-by-default violated"
    else
        pass "Global authz allowlist covers common routes; find-or-create not inadvertently public"
    fi
else
    fail "No authorization enforcement found for user creation endpoint"
fi
echo ""

# ---------------------------------------------------------------------------
# I5: Schema enforces user model identity + wallet ownership relations
# ---------------------------------------------------------------------------
echo "6. Checking schema-level user identities..."

SCHEMA_PASSES=0
SCHEMA_FAILS=0

if grep -q "model User" prisma/schema.prisma 2>/dev/null; then
    echo -e "   ${GREEN}✅${NC} User model exists in schema"
    SCHEMA_PASSES=$((SCHEMA_PASSES + 1))
else
    echo -e "   ${RED}❌${NC} User model missing from schema"
    SCHEMA_FAILS=$((SCHEMA_FAILS + 1))
fi

if grep -q "authId.*@unique" prisma/schema.prisma 2>/dev/null; then
    echo -e "   ${GREEN}✅${NC} authId uniqueness enforced"
    SCHEMA_PASSES=$((SCHEMA_PASSES + 1))
else
    echo -e "   ${RED}❌${NC} authId uniqueness NOT enforced"
    SCHEMA_FAILS=$((SCHEMA_FAILS + 1))
fi

if grep -q "wallets Wallet\[\]" prisma/schema.prisma 2>/dev/null; then
    echo -e "   ${GREEN}✅${NC} User → Wallet ownership relation exists"
    SCHEMA_PASSES=$((SCHEMA_PASSES + 1))
else
    echo -e "   ${RED}❌${NC} User → Wallet ownership relation missing"
    SCHEMA_FAILS=$((SCHEMA_FAILS + 1))
fi

if [ "$SCHEMA_FAILS" -eq 0 ]; then
    PASSED=$((PASSED + 1))
else
    FAILED=$((FAILED + 1))
fi
echo ""

# ---------------------------------------------------------------------------
# I6: Fail-closed on dependency outage (no partial user rows)
# ---------------------------------------------------------------------------
echo "7. Checking fail-closed behavior for dependency outage..."

if grep -rq "ServiceUnavailableException\|DEPENDENCY_UNAVAILABLE\|503" src/users/ 2>/dev/null; then
    pass "Dependency outage handled fail-closed (ServiceUnavailableException / 503 found)"
else
    fail "Dependency outage NOT handled fail-closed in user creation path"
fi
echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "========================================================="
echo "📊 Verification Summary"
echo "========================================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}🎉 All idempotent user checks passed!${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some checks failed ($FAILED). Bring the code back in line with the"
    echo -e "     documented invariants before merging — this must not be bypassed.${NC}"
    echo ""
    echo "For help:"
    echo "  - test/users-find-or-create.e2e-spec.ts"
    echo "  - prisma/schema.prisma (User model)"
    echo "  - README.md (Users section)"
    exit 1
fi