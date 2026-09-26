#!/bin/bash

echo "🔍 Verifying Docker Compose Local Setup"
echo "======================================="

echo ""
echo "1. Checking docker-compose.yml exists..."
if [ -f "docker-compose.yml" ]; then
    echo "✅ docker-compose.yml exists"
else
    echo "❌ docker-compose.yml missing"
fi

echo ""
echo "2. Checking Dockerfile exists..."
if [ -f "Dockerfile" ]; then
    echo "✅ Dockerfile exists"
else
    echo "❌ Dockerfile missing"
fi

echo ""
echo "3. Checking docker-entrypoint.sh exists and is executable..."
if [ -f "docker-entrypoint.sh" ] && [ -x "docker-entrypoint.sh" ]; then
    echo "✅ docker-entrypoint.sh exists and is executable"
else
    echo "❌ docker-entrypoint.sh missing or not executable"
fi

echo ""
echo "4. Checking docs/DOCKER-COMPOSE-LOCAL.md exists..."
if [ -f "docs/DOCKER-COMPOSE-LOCAL.md" ]; then
    echo "✅ docs/DOCKER-COMPOSE-LOCAL.md exists"
else
    echo "❌ docs/DOCKER-COMPOSE-LOCAL.md missing"
fi

echo ""
echo "5. Checking docker-compose.yml has required services (db, api)..."
if grep -q "services:" docker-compose.yml && grep -q "db:" docker-compose.yml && grep -q "api:" docker-compose.yml; then
    echo "✅ Required services (db, api) defined"
else
    echo "❌ Required services missing"
fi

echo ""
echo "6. Checking docker-compose.yml has postgres healthcheck..."
if grep -q "healthcheck:" docker-compose.yml && grep -q "pg_isready" docker-compose.yml; then
    echo "✅ PostgreSQL healthcheck configured"
else
    echo "❌ PostgreSQL healthcheck missing"
fi

echo ""
echo "7. Checking api service depends on db health..."
if grep -q "depends_on:" docker-compose.yml && grep -A5 "depends_on:" docker-compose.yml | grep -q "condition: service_healthy"; then
    echo "✅ API depends on healthy database"
else
    echo "❌ API does not depend on database health"
fi

echo ""
echo "8. Checking DATABASE_URL is overridden in docker-compose.yml..."
if grep -q "DATABASE_URL" docker-compose.yml && grep -q "postgresql://mux:mux_secret@db:5432/mux_db" docker-compose.yml; then
    echo "✅ DATABASE_URL correctly overridden for Docker Compose"
else
    echo "❌ DATABASE_URL not properly configured in docker-compose.yml"
fi

echo ""
echo "9. Checking .env.example has required variables for Docker Compose..."
required_vars=("WALLET_ENCRYPTION_KEY" "STELLAR_HORIZON_URL" "STELLAR_NETWORK" "WEBHOOK_SIGNING_KEY")
missing_vars=()
for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}" .env.example; then
        missing_vars+=("$var")
    fi
done
if [ ${#missing_vars[@]} -eq 0 ]; then
    echo "✅ All required variables documented in .env.example"
else
    echo "❌ Missing variables in .env.example: ${missing_vars[*]}"
fi

echo ""
echo "10. Checking README.md references DOCKER-COMPOSE-LOCAL.md..."
if grep -q "DOCKER-COMPOSE-LOCAL.md" README.md; then
    echo "✅ README.md references Docker Compose local guide"
else
    echo "❌ README.md does not reference Docker Compose local guide"
fi

echo ""
echo "11. Checking Dockerfile uses multi-stage build..."
if grep -q "AS builder" Dockerfile && grep -q "AS runner" Dockerfile; then
    echo "✅ Multi-stage Docker build configured"
else
    echo "❌ Multi-stage build not configured"
fi

echo ""
echo "12. Checking Dockerfile runs prisma migrate deploy on startup..."
if grep -q "docker-entrypoint.sh" Dockerfile && grep -q "prisma migrate deploy" docker-entrypoint.sh; then
    echo "✅ Migrations run automatically on container startup"
else
    echo "❌ Automatic migrations not configured"
fi

echo ""
echo "13. Checking Dockerfile copies prisma schema..."
if grep -q "COPY prisma" Dockerfile; then
    echo "✅ Prisma schema copied to production image"
else
    echo "❌ Prisma schema not copied"
fi

echo ""
echo "14. Checking ports configuration matches documentation..."
if grep -q "3000:3000" docker-compose.yml && grep -q "5432:5432" docker-compose.yml; then
    echo "✅ Ports match documentation (API: 3000, PostgreSQL: 5432)"
else
    echo "❌ Port configuration mismatch"
fi

echo ""
echo "15. Checking volume persistence for PostgreSQL..."
if grep -q "postgres_data" docker-compose.yml && grep -q "/var/lib/postgresql/data" docker-compose.yml; then
    echo "✅ PostgreSQL data volume configured"
else
    echo "❌ PostgreSQL volume missing"
fi

echo ""
echo "======================================="
echo "🎯 Verification Complete!"