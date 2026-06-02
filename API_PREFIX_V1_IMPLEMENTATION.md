# API Prefix v1 Implementation Guide

## Overview
This document describes the implementation of the `/v1` API prefix for the Mux Backend application, as per the bootstrap requirements. All API endpoints are now served under the `/v1` path.

## Changes Made

### 1. Core Bootstrap Change (main.ts)
**File**: `src/main.ts`

The global API prefix was added to the NestJS application bootstrap process:

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(requestLogger as any);
  
  // Set global API prefix for versioning
  app.setGlobalPrefix('v1');
  
  await app.listen(process.env.PORT ?? 3000);
}
```

**Impact**: All endpoints are now automatically prefixed with `/v1/`

### 2. Updated Endpoint Routes

All existing API routes now include the `/v1` prefix:

#### Public Endpoints
- `GET /v1/` - Root endpoint
- `GET /v1/ready` - Readiness probe (returns 200/503 based on DB connectivity)
- `GET /v1/health` - Health check endpoint

#### Authentication Endpoints
- `POST /v1/auth/authenticate` - User authentication and wallet creation (public)

#### Resource Endpoints
- `/v1/users/*` - User management
- `/v1/wallets/*` - Wallet management
- `/v1/payments/*` - Payment processing
- `/v1/api-keys/*` - API key management
- `/v1/developers/*` - Developer information
- `/v1/projects/*` - Project management
- `/v1/limits/*` - Rate limit configuration
- `/v1/recovery/*` - Account recovery
- `/v1/transactions/*` - Transaction history
- `/v1/balances/*` - Balance indexing
- `/v1/webhooks/*` - Webhook management
- `/v1/internal/key-management/*` - Key management (internal)

## Test Changes

### 1. Updated Existing Tests

The following E2E test files were updated to use the new `/v1` prefix:

#### test/app.e2e-spec.ts
- Updated root endpoint test: `GET /v1/` 
- Updated readiness test: `GET /v1/ready`
- All path assertions now expect `/v1/` prefix

#### test/auth-public-endpoint.e2e-spec.ts
- Updated auth endpoint test: `POST /v1/auth/authenticate`
- Verified public access without authentication still works

#### test/error-handling.e2e-spec.ts
- Updated all error path tests to use `/v1/` prefix
- Verified error responses include correct prefixed paths
- Updated all HTTP method tests (GET, POST, PUT, PATCH, DELETE)

#### test/wallets.e2e-spec.ts
- Updated wallet endpoint test: `GET /v1/wallets/protected`
- Verified API key authentication still works with prefix

### 2. New Comprehensive Test Suite

Created `test/api-prefix-v1.e2e-spec.ts` to comprehensively verify:

**Global Prefix Verification**
- Root endpoint serves at `/v1/`
- Endpoints without prefix return 404
- Public endpoints accessible without authentication
- Health and readiness probes work with prefix

**Controller Route Coverage**
- All major controller routes respond with `/v1` prefix:
  - Auth routes
  - Users routes
  - Wallets routes
  - API keys routes
  - Developers routes
  - Projects routes

**Error Handling**
- Error responses include `/v1` prefix in path
- 404 responses for routes without prefix

**Public Endpoint Accessibility**
- Root endpoint accessible without auth
- Readiness probe accessible without auth
- Health check accessible without auth
- Auth endpoint accessible without API key

**HTTP Methods**
- GET, POST, PUT, PATCH, DELETE all work with prefix
- Requests without prefix return 404

## Behavior Summary

### Before Implementation
```
GET / → 200 (Hello World!)
GET /ready → 200 (readiness status)
GET /health → 200 (health check)
POST /auth/authenticate → processes authentication
GET /users → returns users
```

### After Implementation
```
GET /v1/ → 200 (Hello World!)
GET /v1/ready → 200 (readiness status)
GET /v1/health → 200 (health check)
POST /v1/auth/authenticate → processes authentication
GET /v1/users → returns users

GET / → 404 (Not Found)
GET /ready → 404 (Not Found)
GET /health → 404 (Not Found)
POST /auth/authenticate → 404 (Not Found)
```

## Testing Instructions

### Run E2E Tests
```bash
# Run all e2e tests (includes existing tests + new prefix verification tests)
pnpm test:e2e

# Run specific test file
pnpm test:e2e -- test/api-prefix-v1.e2e-spec.ts

# Run with verbose output
pnpm test:e2e -- --verbose

# Run with coverage
pnpm test:e2e -- --coverage
```

### Run Unit Tests
```bash
pnpm test
```

### Run All Tests
```bash
# Run all tests (unit + e2e)
pnpm test:e2e && pnpm test
```

## Verification Checklist

Use these steps to verify the implementation is working correctly:

### 1. Start the Application
```bash
pnpm start:dev
```

### 2. Verify Endpoints with Curl

**Public Endpoints**
```bash
# Root endpoint
curl http://localhost:3000/v1/
# Expected: Hello World!

# Readiness probe
curl http://localhost:3000/v1/ready
# Expected: JSON with status: "ready"

# Health check
curl http://localhost:3000/v1/health
# Expected: JSON with health status
```

**Authentication Endpoint**
```bash
curl -X POST http://localhost:3000/v1/auth/authenticate \
  -H "Content-Type: application/json" \
  -d '{
    "authId": "test-123",
    "email": "test@example.com",
    "displayName": "Test User",
    "authProvider": "CLERK",
    "network": "TESTNET"
  }'
# Expected: User and wallet data (or error if validation fails)
```

**Verify 404 for Non-Prefixed Routes**
```bash
curl http://localhost:3000/
# Expected: 404 Not Found

curl http://localhost:3000/ready
# Expected: 404 Not Found

curl http://localhost:3000/health
# Expected: 404 Not Found
```

### 3. Run Tests
Execute the comprehensive test suite:
```bash
pnpm test:e2e
```

Expected outcome: All tests pass, including:
- ✓ Root endpoint at `/v1/` returns content
- ✓ Root endpoint without prefix returns 404
- ✓ Readiness endpoint at `/v1/ready` works
- ✓ Health endpoint at `/v1/health` works
- ✓ Auth endpoint at `/v1/auth/authenticate` is public
- ✓ All controller routes have `/v1` prefix
- ✓ Error responses include correct paths
- ✓ Public endpoints remain accessible without auth

## Backward Compatibility Considerations

### Breaking Changes
The `/v1` prefix is a **breaking change** for existing API consumers:
- All existing client implementations must update their API endpoints
- Old endpoints (without `/v1`) will return 404 Not Found

### Migration Guide for Clients
Update all API calls from:
```
http://api.example.com/endpoint
```
to:
```
http://api.example.com/v1/endpoint
```

Examples:
- `https://api.example.com/auth/authenticate` → `https://api.example.com/v1/auth/authenticate`
- `https://api.example.com/wallets` → `https://api.example.com/v1/wallets`
- `https://api.example.com/users` → `https://api.example.com/v1/users`

## Future Versioning

This implementation enables future API versioning strategies:
- `/v2` endpoints can be added by creating new controller prefixes
- Both `/v1` and `/v2` can coexist using separate prefixes per controller
- The global prefix can be made configurable via environment variables if needed

Example for future versions:
```typescript
const apiVersion = process.env.API_VERSION ?? 'v1';
app.setGlobalPrefix(apiVersion);
```

## Related Files Modified

### Core Application
- `src/main.ts` - Bootstrap with global prefix

### Test Files
- `test/app.e2e-spec.ts` - Updated to use `/v1`
- `test/auth-public-endpoint.e2e-spec.ts` - Updated to use `/v1`
- `test/error-handling.e2e-spec.ts` - Updated to use `/v1`
- `test/wallets.e2e-spec.ts` - Updated to use `/v1`
- `test/api-prefix-v1.e2e-spec.ts` - New comprehensive test suite

### No Changes Required
- Controllers remain unchanged (no modifications to `@Controller()` decorators)
- Services remain unchanged
- Middleware remains unchanged
- Guards and interceptors remain unchanged

## Acceptance Criteria - Met

✅ **Behavior is covered by tests**
- Added comprehensive test suite (api-prefix-v1.e2e-spec.ts)
- Updated all existing e2e tests to verify new routes
- Tests verify prefix application, public access, error handling, and HTTP methods

✅ **Documented where APIs changed**
- This document provides complete API endpoint changes
- All endpoints now require `/v1` prefix
- Migration guide provided for clients

✅ **No regressions in closely related flows**
- All existing functionality works with new prefix
- Public endpoints remain public (no new auth requirements)
- Error handling unchanged (only path representation differs)
- Rate limiting, API key validation unchanged

✅ **Follows existing patterns in repository**
- Uses NestJS built-in `setGlobalPrefix()` method
- Follows repository's testing patterns (Jest + Supertest)
- Maintains existing module and security structure

✅ **Handles edge cases gracefully**
- Returns proper 404 for non-prefixed routes
- Preserves authentication requirements
- Maintains error response structure and logging
- Request tracking (x-request-id) still works

## Summary

The `/v1` API prefix has been successfully implemented as a global prefix applied to all endpoints during application bootstrap. This provides:

1. **Clear Versioning**: APIs now explicitly indicate they are v1
2. **Future Compatibility**: Enables multiple API versions to coexist
3. **Professional API Design**: Follows REST API best practices
4. **Full Test Coverage**: Comprehensive test suite verifies all aspects
5. **No Breaking Internal Changes**: Controllers, services, and guards remain unchanged
6. **Graceful Fallback**: Non-prefixed routes properly return 404

All acceptance criteria have been met, and the implementation is ready for deployment.
