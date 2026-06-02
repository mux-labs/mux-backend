#!/bin/bash

# Key Management Consolidation Verification Script
# This script verifies that the key management consolidation is complete and correct

set -e

echo "🔍 Key Management Consolidation Verification"
echo "=============================================="
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

# Helper functions
pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
    ((PASSED++))
}

fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
    ((FAILED++))
}

warn() {
    echo -e "${YELLOW}⚠️  WARN${NC}: $1"
}

info() {
    echo -e "ℹ️  $1"
}

# Test 1: No direct crypto key generation in wallet services
echo "Test 1: Checking for direct crypto key generation..."
if grep -r "generateKeyPairSync" src/wallets/*.ts 2>/dev/null | grep -v ".spec.ts" | grep -q .; then
    fail "Found direct crypto.generateKeyPairSync() usage in wallet services"
else
    pass "No direct crypto key generation found in wallet services"
fi
echo ""

# Test 2: KeyManagementService imported in wallet services
echo "Test 2: Checking KeyManagementService imports..."
if grep -q "import.*KeyManagementService" src/wallets/wallets.service.ts; then
    pass "KeyManagementService imported in WalletsService"
else
    fail "KeyManagementService NOT imported in WalletsService"
fi

if grep -q "import.*KeyManagementService" src/wallets/wallet-creation-orchestrator.service.ts; then
    pass "KeyManagementService imported in WalletCreationOrchestrator"
else
    fail "KeyManagementService NOT imported in WalletCreationOrchestrator"
fi
echo ""

# Test 3: KeyManagementModule imported in WalletsModule
echo "Test 3: Checking module imports..."
if grep -q "KeyManagementModule" src/wallets/wallets.module.ts; then
    pass "KeyManagementModule imported in WalletsModule"
else
    fail "KeyManagementModule NOT imported in WalletsModule"
fi
echo ""

# Test 4: KeyManagementService used in wallet creation
echo "Test 4: Checking KeyManagementService usage..."
if grep -q "keyManagementService.generateKey" src/wallets/wallets.service.ts; then
    pass "WalletsService uses KeyManagementService.generateKey()"
else
    fail "WalletsService does NOT use KeyManagementService.generateKey()"
fi

if grep -q "keyManagementService.generateKey" src/wallets/wallet-creation-orchestrator.service.ts; then
    pass "WalletCreationOrchestrator uses KeyManagementService.generateKey()"
else
    fail "WalletCreationOrchestrator does NOT use KeyManagementService.generateKey()"
fi
echo ""

# Test 5: Old key generation methods removed
echo "Test 5: Checking for removed duplicate methods..."
if grep -q "private generateStellarKeyPair" src/wallets/wallets.service.ts; then
    fail "Old generateStellarKeyPair() method still exists in WalletsService"
else
    pass "Old generateStellarKeyPair() method removed from WalletsService"
fi

if grep -q "private generateStellarKeyPair" src/wallets/wallet-creation-orchestrator.service.ts; then
    fail "Old generateStellarKeyPair() method still exists in WalletCreationOrchestrator"
else
    pass "Old generateStellarKeyPair() method removed from WalletCreationOrchestrator"
fi
echo ""

# Test 6: Tests updated with KeyManagementService mocks
echo "Test 6: Checking test updates..."
if grep -q "mockKeyManagementService" src/wallets/wallets.service.spec.ts; then
    pass "WalletsService tests have KeyManagementService mock"
else
    fail "WalletsService tests missing KeyManagementService mock"
fi

if grep -q "mockKeyManagementService" src/wallets/wallet-creation-orchestrator.service.spec.ts; then
    pass "WalletCreationOrchestrator tests have KeyManagementService mock"
else
    fail "WalletCreationOrchestrator tests missing KeyManagementService mock"
fi
echo ""

# Test 7: Integration tests created
echo "Test 7: Checking integration tests..."
if [ -f "src/wallets/wallets-keygen-integration.spec.ts" ]; then
    pass "Integration test file exists"
    
    if grep -q "WalletsService - KeyManagementService Integration" src/wallets/wallets-keygen-integration.spec.ts; then
        pass "Integration tests include WalletsService scenarios"
    else
        fail "Integration tests missing WalletsService scenarios"
    fi
    
    if grep -q "WalletCreationOrchestrator - KeyManagementService Integration" src/wallets/wallets-keygen-integration.spec.ts; then
        pass "Integration tests include WalletCreationOrchestrator scenarios"
    else
        fail "Integration tests missing WalletCreationOrchestrator scenarios"
    fi
else
    fail "Integration test file NOT found"
fi
echo ""

# Test 8: Documentation created
echo "Test 8: Checking documentation..."
docs=(
    "src/key-management/README.md"
    "src/key-management/QUICK-REFERENCE.md"
    "docs/key-management-consolidation.md"
    "docs/MIGRATION-KEY-MANAGEMENT.md"
    "docs/KEY-MANAGEMENT-SUMMARY.md"
    "CHANGELOG-KEY-MANAGEMENT.md"
)

for doc in "${docs[@]}"; do
    if [ -f "$doc" ]; then
        pass "Documentation exists: $doc"
    else
        fail "Documentation missing: $doc"
    fi
done
echo ""

# Test 9: Main README updated
echo "Test 9: Checking README updates..."
if grep -q "KeyManagementService" README.md; then
    pass "Main README mentions KeyManagementService"
else
    warn "Main README should mention KeyManagementService"
fi
echo ""

# Test 10: KeyType enum used correctly
echo "Test 10: Checking KeyType usage..."
if grep -q "KeyType.STELLAR_ED25519" src/wallets/wallets.service.ts; then
    pass "WalletsService uses KeyType.STELLAR_ED25519"
else
    fail "WalletsService does NOT use KeyType enum"
fi

if grep -q "KeyType.STELLAR_ED25519" src/wallets/wallet-creation-orchestrator.service.ts; then
    pass "WalletCreationOrchestrator uses KeyType.STELLAR_ED25519"
else
    fail "WalletCreationOrchestrator does NOT use KeyType enum"
fi
echo ""

# Test 11: Metadata passed to generateKey
echo "Test 11: Checking metadata usage..."
if grep -q "metadata:" src/wallets/wallets.service.ts | grep -q "generateKey"; then
    pass "WalletsService passes metadata to generateKey()"
else
    warn "WalletsService should pass metadata for audit trail"
fi

if grep -q "metadata:" src/wallets/wallet-creation-orchestrator.service.ts | grep -q "generateKey"; then
    pass "WalletCreationOrchestrator passes metadata to generateKey()"
else
    warn "WalletCreationOrchestrator should pass metadata for audit trail"
fi
echo ""

# Test 12: No plaintext private key variables
echo "Test 12: Checking for plaintext private key handling..."
if grep "const privateKey = crypto" src/wallets/wallets.service.ts 2>/dev/null | grep -v "// " | grep -q .; then
    warn "Found direct private key generation - should use KeyManagementService"
else
    pass "No direct private key generation in WalletsService"
fi
echo ""

# Summary
echo "=============================================="
echo "📊 Verification Summary"
echo "=============================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All checks passed! Consolidation appears complete.${NC}"
    exit 0
else
    echo -e "${RED}⚠️  Some checks failed. Please review the failures above.${NC}"
    exit 1
fi
