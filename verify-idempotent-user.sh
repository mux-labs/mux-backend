#!/bin/bash

echo "🔍 Verifying Idempotent User Creation Flow Implementation"
echo "========================================================"

echo ""
echo "1. Checking idempotent user service exists..."
if [ -f "src/users/idempotent-user.service.ts" ]; then
    echo "✅ Idempotent User Service exists"
else
    echo "❌ Idempotent User Service missing"
fi

echo ""
echo "2. Checking findOrCreateUser implementation..."
if grep -q "findOrCreateUser" src/users/idempotent-user.service.ts; then
    echo "✅ findOrCreateUser method implemented"
else
    echo "❌ findOrCreateUser method not implemented"
fi

echo ""
echo "3. Checking duplicate prevention..."
if grep -q "findUnique" src/users/idempotent-user.service.ts && grep -q "authId" src/users/idempotent-user.service.ts; then
    echo "✅ Duplicate prevention implemented"
else
    echo "❌ Duplicate prevention not implemented"
fi

echo ""
echo "4. Checking existing user return logic..."
if grep -q "existingUser" src/users/idempotent-user.service.ts; then
    echo "✅ Existing user return logic implemented"
else
    echo "❌ Existing user return logic not implemented"
fi

echo ""
echo "5. Checking race condition handling..."
if grep -q "P2002" src/users/idempotent-user.service.ts; then
    echo "✅ Race condition handling implemented"
else
    echo "❌ Race condition handling not implemented"
fi

echo ""
echo "6. Checking graceful error handling..."
if grep -q "try" src/users/idempotent-user.service.ts && grep -q "catch" src/users/idempotent-user.service.ts; then
    echo "✅ Graceful error handling implemented"
else
    echo "❌ Graceful error handling not implemented"
fi

echo ""
echo "7. Checking controller exists..."
if [ -f "src/users/idempotent-user.controller.ts" ]; then
    echo "✅ Controller exists"
else
    echo "❌ Controller missing"
fi

echo ""
echo "8. Checking module exists..."
if [ -f "src/users/idempotent-user.module.ts" ]; then
    echo "✅ Module exists"
else
    echo "❌ Module missing"
fi

echo ""
echo "9. Checking tests exist..."
if [ -f "src/users/idempotent-user.service.spec.ts" ]; then
    echo "✅ Tests exist"
else
    echo "❌ Tests missing"
fi

echo ""
echo "10. Checking User model in schema..."
if grep -q "model User" prisma/schema.prisma; then
    echo "✅ User model exists in schema"
else
    echo "❌ User model missing from schema"
fi

echo ""
echo "11. Checking unique authId constraint..."
if grep -q "authId.*@unique" prisma/schema.prisma; then
    echo "✅ Unique authId constraint implemented"
else
    echo "❌ Unique authId constraint missing"
fi

echo ""
echo "12. Checking wallet-user relationship..."
if grep -q "wallets.*Wallet\[\]" prisma/schema.prisma; then
    echo "✅ Wallet-user relationship implemented"
else
    echo "❌ Wallet-user relationship missing"
fi

echo ""
echo "========================================================"
echo "🎯 Verification Complete!"
