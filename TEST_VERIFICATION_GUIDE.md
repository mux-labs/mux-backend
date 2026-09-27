# Test Verification Guide - API Prefix v1

## Overview
This guide provides step-by-step instructions to verify that the `/v1` API prefix implementation is working correctly. The implementation includes both updates to existing tests and a new comprehensive test suite.

## E2E Proof: auth → wallet → limits → dry-run payment

This section documents the end-to-end proof for the critical money path. It is the
canonical verification for issue #983 and must stay consistent with
`docs/PAYMENT-DRY-RUN.md`. The proof exercises the full chain in order:

1. **auth** — authenticate a principal and obtain a session/JWT.
2. **wallet** — resolve or provision the invisible wallet for that principal.
3. **limits** — read and enforce the spend/velocity limits for the wallet.
4. **dry-run payment** — simulate a payment without moving funds.

### Invariants

- The server is the source of truth for spends, recovery, and admin actions.
- Every step is deny-by-default: missing/expired/revoked credentials fail closed.
- Writes are idempotent: a replayed request with the same idempotency key returns
  the original result and never double-spends.
- On dependency outage (RPC/DB/Horizon) writes fail closed; reads may degrade.
- Dry-run never mutates balances and never broadcasts a transaction.
- No secrets (keys, JWTs, webhook secrets) appear in logs or responses.

### Running the E2E proof

```bash
# Full critical-path proof
pnpm test:e2e -- test/e2e-auth-wallet-limits-dryrun.e2e-spec.ts

# Authz negatives only
pnpm test:e2e -- test/e2e-auth-wallet-limits-dryrun.e2e-spec.ts -t "authz"

# Idempotency / replay only
pnpm test:e2e -- test/e2e-auth-wallet-limits-dryrun.e2e-spec.ts -t "idempotency"

# Fail-closed on dependency outage only
pnpm test:e2e -- test/e2e-auth-wallet-limits-dryrun.e2e-spec.ts -t "fail-closed"
```

### Critical-path cases

```
✓ auth: valid principal obtains a session
✓ auth: missing credentials -> 401 (fail closed)
✓ auth: expired JWT -> 401
✓ auth: revoked delegate -> 403
✓ auth: wrong role (guardian on owner-only route) -> 403
✓ auth: API key without required scope -> 403
✓ wallet: resolves wallet for authenticated principal
✓ wallet: cannot read another principal's wallet -> 403/404
✓ limits: returns spend/velocity limits for the wallet
✓ limits: payment exceeding limit -> 422 (deny by default)
✓ dry-run: simulates payment without mutating balances
✓ dry-run: response carries correlation id (x-request-id)
✓ idempotency: replayed dry-run with same key returns original result
✓ idempotency: concurrent duplicate requests do not double-apply
✓ fail-closed: RPC/DB/Horizon outage -> write rejected, no partial state
✓ observability: errors are actionable and redact secrets
```

### Manual checklist (when automation cannot cover extensions)

- [ ] Confirm `x-request-id` is echoed on every step and present in logs.
- [ ] Confirm dry-run responses contain no raw key material or JWTs.
- [ ] Confirm the money-path feature flag / kill-switch is documented in
      `docs/FEATURE-FLAGS.md` and defaults to safe (off) on mainnet.
- [ ] Confirm testnet vs mainnet config cannot be silently swapped.

## Pre-Verification Checklist

Before running tests, ensure:
- [ ] Node.js and npm/pnpm are installed
- [ ] Dependencies are installed (`pnpm install`)
- [ ] PostgreSQL database is accessible (for E2E tests)
- [ ] Environment variables are configured (.env file)
- [ ] No other service is running on port 3000

## Test Suite Overview

### Existing Test Files (Updated)
These test files were updated to use the new `/v1` prefix:

1. **test/app.e2e-spec.ts**
   - Tests root endpoint: `GET /v1/` 
   - Tests readiness probe: `GET /v1/ready`
   - Verifies 404 for non-prefixed routes

2. **test/auth-public-endpoint.e2e-spec.ts**
   - Tests authentication endpoint: `POST /v1/auth/authenticate`
   - Verifies public access without API key

3. **test/error-handling.e2e-spec.ts**
   - Tests error responses include correct `/v1` paths
   - Tests all HTTP methods (GET, POST, PUT, PATCH, DELETE)
   - Verifies error response structure

4. **test/wallets.e2e-spec.ts**
   - Tests wallet endpoint: `GET /v1/wallets/protected`
   - Tests wallet creation and wallet status paths
   - Verifies `x-request-id` propagation in headers
   - Verifies API key authentication with prefix

### New Test File
**test/api-prefix-v1.e2e-spec.ts**
- Comprehensive test suite with 40+ test cases
- Organized into logical test suites
- Covers all major endpoints and edge cases

## Running Tests

### Option 1: Run All E2E Tests
```bash
# Navigate to project directory
cd /workspaces/mux-backend

# Install dependencies (if needed)
pnpm install

# Run all e2e tests
pnpm test:e2e
```

**Expected Output:**
```
PASS  test/app.e2e-spec.ts
PASS  test/auth-public-endpoint.e2e-spec.ts
PASS  test/error-handling.e2e-spec.ts
PASS  test/wallets.e2e-spec.ts
PASS  test/api-prefix-v1.e2e-spec.ts

Test Suites: 5 passed, 5 total
Tests:       XX passed, XX total
```

### Option 2: Run Prefix Verification Test Only
```bash
pnpm test:e2e -- test/api-prefix-v1.e2e-spec.ts
```

**Expected Output:**
```
PASS  test/api-prefix-v1.e2e-spec.ts
  API Prefix /v1 (e2e)
    Global /v1 prefix verification
      ✓ should serve root endpoint at /v1/ (XX ms)
      ✓ should return 404 for root endpoint without prefix (XX ms)
      ✓ should serve /v1/ready endpoint (XX ms)
      ✓ should return 404 for /ready endpoint without prefix (XX ms)
      ...
```

### Option 3: Run Specific Test Suite
```bash
# Run only the "Global /v1 prefix verification" tests
pnpm test:e2e -- test/api-prefix-v1.e2e-spec.ts -t "Global /v1 prefix"
```

### Option 4: Run with Verbose Output
```bash
pnpm test:e2e -- --verbose
```

### Option 5: Run with Coverage
```bash
pnpm test:e2e -- --coverage
```

## Test Cases Verification

### Test Suite 1: Global /v1 Prefix Verification (6 tests)
```
✓ should serve root endpoint at /v1/
✓ should return 404 for root endpoint without prefix
✓ should serve /v1/ready endpoint
✓ should return 404 for /ready endpoint without prefix
✓ should serve /v1/health endpoint
✓ should return 404 for /health endpoint without prefix
```

**What it verifies:**
- Global prefix is applied correctly
- Non-prefixed routes return 404
- Public health/readiness probes work with prefix

### Test Suite 2: Controller Routes with /v1 Prefix (12 tests)
```
✓ should respond to /v1/auth/* routes
✓ should return 404 for auth routes without /v1 prefix
✓ should respond to /v1/users routes
✓ should return 404 for users routes without /v1 prefix
✓ should respond to /v1/wallets routes
✓ should return 404 for wallets routes without /v1 prefix
✓ should respond to /v1/api-keys routes
✓ should return 404 for api-keys routes without /v1 prefix
✓ should respond to /v1/developers routes
✓ should return 404 for developers routes without /v1 prefix
✓ should respond to /v1/projects routes
✓ should return 404 for projects routes without /v1 prefix
```

**What it verifies:**
- All major controller routes have /v1 prefix
- Routes without prefix properly return 404

### Test Suite 3: Error Handling with /v1 Prefix (2 tests)
```
✓ should include /v1 prefix in error response path
✓ should return 404 for non-existent route without prefix
```

**What it verifies:**
- Error responses include correct prefixed paths
- Error handling works properly

### Test Suite 4: Public Endpoint Accessibility (5 tests)
```
✓ /v1/ should be accessible without authentication
✓ /v1/ready should be accessible without authentication
✓ /v1/health should be accessible without authentication
✓ /v1/auth/authenticate should be accessible without API key
```

**What it verifies:**
- Public endpoints remain accessible
- No new authentication requirements introduced

### Test Suite 5: Request/Response Headers (2 tests)
```
✓ should preserve custom headers with /v1 prefix
✓ should return proper content-type with /v1 prefix
```

**What it verifies:**
- Headers are properly processed
- Content-Type headers correct

### Test Suite 6: HTTP Methods (3 tests)
```
✓ should handle GET requests with /v1 prefix
✓ should handle POST requests with /v1 prefix
✓ should handle POST requests without /v1 prefix as 404
```

**What it verifies:**
- All HTTP methods work with prefix
- Non-prefixed requests fail

## Manual Testing (Without Tests)

If you want to manually verify the implementation:

### 1. Start the Application
```bash
cd /workspaces/mux-backend
pnpm start:dev
```

Wait for the application to start:
```
[Nest] 12345  - 01/01/2026, 12:00:00 PM     LOG [NestFactory] Starting Nest application...
[Nest] 12345  - 01/01/2026, 12:00:00 PM     LOG [InstanceLoader] AppModule dependencies initialized...
[Nest] 12345  - 01/01/2026, 12:00:00 PM     LOG [RoutesResolver] AppController {/v1}:
[Nest] 12345  - 01/01/2026, 12:00:00 PM     LOG [RoutesResolver] HealthController {/v1/health}:
[Nest] 12345  - 01/01/2026, 12:00:00 PM     LOG [RoutesResolver] AuthOrchestratorController {/v1/auth}:
...
```

**Note:** Observe that routes include the `/v1` prefix in the RoutesResolver logs.

### 2. Test Public Endpoints
```bash
# Test root endpoint
curl http://localhost:3000/v1/
# Expected output: Hello World!

# Test readiness probe
curl http://localhost:3000/v1/ready
# Expected output: {"status":"ready","timestamp":"...","database":{"connected":true,"responseTime":...}}

# Test health check
curl http://localhost:3000/v1/health
# Expected output: {"status":"ok",...}
```

### 3. Test Authentication Endpoint
```bash
curl -X POST http://localhost:3000/v1/auth/authenticate \
  -H "Content-Type: application/json" \
  -d '{
    "authId": "test-user-123",
    "email": "test@example.com",
    "displayName": "Test User",
    "authProvider": "CLERK",
    "network": "TESTNET"
  }'

# Expected: User and wallet data (or error if DB connection fails)
# Status: 200/201 or error code
```

### 4. Verify 404 for Non-Prefixed Routes
```bash
# Root without prefix
curl http://localhost:3000/
# Expected: 404 Not Found

# Ready without prefix
curl http://localhost:3000/ready
# Expected: 404 Not Found

# Health without prefix
curl http://localhost:3000/health
# Expected: 404 Not Found

# Auth without prefix
curl -X POST http://localhost:3000/auth/authenticate \
  -H "Content-Type: application/json" \
  -d '{"authId":"test",...}'
# Expected: 404 Not Found
```

### 5. Test Error Responses Include Prefix
```bash
curl http://localhost:3000/v1/non-existent-endpoint
# Expected output: 
# {
#   "statusCode": 404,
#   "path": "/v1/non-existent-endpoint",  <-- Note /v1/ in path
#   "timestamp": "...",
#   "message": "Not Found",
#   "error": "Not Found",
#   "method": "GET"
# }
```

## Troubleshooting

### Issue: Tests fail with "Cannot find module"
**Solution:** Run `pnpm install` to install dependencies

### Issue: Database connection errors
**Solution:** Verify DATABASE_URL environment variable is set and the database is reachable.
