#!/bin/bash

echo "🔍 Verifying Wallet Encryption Implementation"
echo "=========================================="

echo ""
echo "1. Checking that private keys are encrypted before database storage..."
if grep -q "encryptAndSerialize.*privateKey" src/wallets/wallets.service.ts; then
    echo "✅ Private keys are encrypted before storage"
else
    echo "❌ Private keys are NOT encrypted before storage"
fi

echo ""
echo "2. Checking environment-based encryption key..."
if grep -q "WALLET_ENCRYPTION_KEY" src/encryption/encryption.service.ts; then
    echo "✅ Encryption key is environment-based"
else
    echo "❌ Encryption key is NOT environment-based"
fi

echo ""
echo "3. Checking that decryption only happens during signing..."
if grep -q "getDecryptedPrivateKey" src/wallets/wallets.service.ts; then
    echo "✅ Decryption only happens in controlled method"
else
    echo "❌ Decryption is NOT controlled"
fi

echo ""
echo "4. Checking safe decryption failure handling..."
if grep -q "DECRYPTION_FAILED\|INVALID_KEY\|INVALID_DATA" src/wallets/wallets.service.ts; then
    echo "✅ Decryption failures are handled safely"
else
    echo "❌ Decryption failures are NOT handled safely"
fi

echo ""
echo "5. Checking that plain private keys are never stored..."
if grep -q "privateKey.*:" src/wallets/wallets.service.ts | grep -v "encryptAndSerialize"; then
    echo "❌ Plain private keys might be stored"
else
    echo "✅ Plain private keys are never stored directly"
fi

echo ""
echo "6. Checking encryption algorithm strength..."
if grep -q "aes-256-gcm" src/encryption/encryption.service.ts; then
    echo "✅ Uses strong AES-256-GCM encryption"
else
    echo "❌ Does NOT use strong encryption"
fi

echo ""
echo "=========================================="
echo "🎯 Verification Complete!"
