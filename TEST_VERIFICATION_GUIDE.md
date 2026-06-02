# Test Verification Guide - API Prefix v1

## Overview
This guide provides step-by-step instructions to verify that the `/v1` API prefix implementation is working correctly. The implementation includes both updates to existing tests and a new comprehensive test suite.

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
**Solution:** Verify DATABASE_URL environment variable is set correctly in .env file

### Issue: Port 3000 already in use
**Solution:** Change PORT environment variable or kill process using port 3000

### Issue: Tests timeout
**Solution:** Increase Jest timeout: `jest.setTimeout(30000)`

### Issue: Auth endpoint returns 500 error
**Solution:** Verify database is running and accessible

## Acceptance Criteria Verification

Use this checklist to confirm all acceptance criteria are met:

### ✓ Behavior is covered by tests and documented
- [ ] Run `pnpm test:e2e` - all tests pass
- [ ] Comprehensive test suite in test/api-prefix-v1.e2e-spec.ts
- [ ] All test cases cover /v1 prefix behavior
- [ ] API_PREFIX_V1_IMPLEMENTATION.md documents all changes

### ✓ No regressions in closely related user or API flows
- [ ] Authentication still works with `/v1/auth/authenticate`
- [ ] Public endpoints still accessible without API key
- [ ] Rate limiting and API key validation unchanged
- [ ] Error handling works correctly with new prefix
- [ ] Request logging includes correct paths

### ✓ Handles edge cases gracefully
- [ ] Non-existent endpoints return proper 404
- [ ] Error responses include prefix in path
- [ ] Custom headers preserved
- [ ] All HTTP methods work correctly

### ✓ Follows existing patterns
- [ ] Uses NestJS built-in setGlobalPrefix() method
- [ ] Test structure matches existing patterns
- [ ] Module organization unchanged
- [ ] No modification to controller decorators

## Test Execution Report Template

Use this template to document test results:

```
=== API Prefix v1 Test Execution Report ===
Date: [Date]
Environment: [Development/Staging/Production]
Tester: [Name]

Test Execution Results:
- Total Tests Run: ___
- Tests Passed: ___
- Tests Failed: ___
- Tests Skipped: ___

Issues Found: 
[None / List any issues]

Coverage:
- Core implementation: ✓
- Error handling: ✓
- Public endpoints: ✓
- Authentication: ✓
- All HTTP methods: ✓

Approval: [Date/Signature]
```

## Summary

The test verification process confirms:
1. ✅ All endpoints properly prefixed with `/v1`
2. ✅ Non-prefixed routes return 404
3. ✅ Public endpoints remain accessible
4. ✅ Error handling includes prefix
5. ✅ All HTTP methods work correctly
6. ✅ No regressions in existing functionality

The implementation is production-ready when all tests pass.
