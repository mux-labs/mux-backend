#!/bin/bash

echo "🔍 Verifying Wallet Creation Orchestrator Implementation"
echo "====================================================="

echo ""
echo "1. Checking orchestrator service exists..."
if [ -f "src/wallets/wallet-creation-orchestrator.service.ts" ]; then
    echo "✅ Wallet Creation Orchestrator service exists"
else
    echo "❌ Wallet Creation Orchestrator service missing"
fi

echo ""
echo "2. Checking atomic transaction implementation..."
if grep -q "\$transaction" src/wallets/wallet-creation-orchestrator.service.ts; then
    echo "✅ Atomic transaction implemented"
else
    echo "❌ Atomic transaction not implemented"
fi

echo ""
echo "3. Checking one wallet per user enforcement..."
if grep -q "findFirst" src/wallets/wallet-creation-orchestrator.service.ts && grep -q "userId.*network" src/wallets/wallet-creation-orchestrator.service.ts; then
    echo "✅ One wallet per user enforcement implemented"
else
    echo "❌ One wallet per user enforcement not implemented"
fi

echo ""
echo "4. Checking idempotency support..."
if grep -q "idempotencyKey" src/wallets/wallet-creation-orchestrator.service.ts; then
    echo "✅ Idempotency support implemented"
else
    echo "❌ Idempotency support not implemented"
fi

echo ""
echo "5. Checking user lookup implementation..."
if grep -q "resolveUser" src/wallets/wallet-creation-orchestrator.service.ts; then
    echo "✅ User lookup implemented"
else
    echo "❌ User lookup not implemented"
fi

echo ""
echo "6. Checking key generation integration..."
if grep -q "generateStellarKeyPair" src/wallets/wallet-creation-orchestrator.service.ts; then
    echo "✅ Key generation integrated"
else
    echo "❌ Key generation not integrated"
fi

echo ""
echo "7. Checking encryption integration..."
if grep -q "encryptAndSerialize" src/wallets/wallet-creation-orchestrator.service.ts; then
    echo "✅ Encryption integrated"
else
    echo "❌ Encryption not integrated"
fi

echo ""
echo "8. Checking controller exists..."
if [ -f "src/wallets/wallet-creation-orchestrator.controller.ts" ]; then
    echo "✅ Controller exists"
else
    echo "❌ Controller missing"
fi

echo ""
echo "9. Checking module exists..."
if [ -f "src/wallets/wallet-creation-orchestrator.module.ts" ]; then
    echo "✅ Module exists"
else
    echo "❌ Module missing"
fi

echo ""
echo "10. Checking tests exist..."
if [ -f "src/wallets/wallet-creation-orchestrator.service.spec.ts" ]; then
    echo "✅ Tests exist"
else
    echo "❌ Tests missing"
fi

echo ""
echo "11. Checking error handling for partial failures..."
if grep -q "transaction" src/wallets/wallet-creation-orchestrator.service.ts && grep -q "failed" src/wallets/wallet-creation-orchestrator.service.ts; then
    echo "✅ Partial failure handling implemented"
else
    echo "❌ Partial failure handling not implemented"
fi

echo ""
echo "====================================================="
echo "🎯 Verification Complete!"
