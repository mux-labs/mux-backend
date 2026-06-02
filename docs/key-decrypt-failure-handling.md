# Key Decrypt Failure Handling

## Overview

This document describes the key decrypt failure handling feature added to the Mux Protocol backend's key management system. The feature ensures that encryption/decryption failures are detected, logged, reported, and surfaced with proper HTTP status codes and structured error responses.

## Motivation

Before this feature, key decryption failures were handled inconsistently:
- `WalletsService` caught decrypt errors by checking `.code` property on plain `Error` objects (fragile type checking)
- `KeyManagementService` wrapped all signing failures into generic `Error('Signing failed')` — losing context
- `StellarKeyProvider` swallowed all errors into generic `'Signing failed'` messages
- No typed HTTP exception for decrypt failures — all errors defaulted to 500 Internal Server Error

**Problems:**
- Clients couldn't distinguish decrypt failures (corrupt data, wrong key) from network/service errors
- Operators couldn't easily identify decrypt failures in logs (generic error messages)
- Tests couldn't reliably assert on decrypt error paths (`instanceof` didn't work)

## Changes

### 1. Typed `DecryptionError` Class

**File:** `src/encryption/encryption.service.ts`

Changed `DecryptionError` from an interface to a proper error class:

```typescript
export class DecryptionError extends Error {
  readonly code: DecryptionErrorCode;

  constructor(message: string, code: DecryptionErrorCode) {
    super(message);
    this.name = 'DecryptionError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
```

**Benefits:**
- `instanceof DecryptionError` now works correctly
- Tests can reliably assert on decrypt failures
- Error propagation is type-safe

**Error Codes:**
- `DECRYPTION_FAILED` — authentication tag failure, corrupt ciphertext
- `INVALID_KEY` — wrong encryption key (rotation, config mismatch)
- `INVALID_DATA` — malformed input, missing fields, bad JSON

### 2. `KeyDecryptionException` for HTTP Layer

**File:** `src/key-management/exceptions/key-decryption.exception.ts`

New NestJS `HttpException` that maps decrypt failures to **422 Unprocessable Entity**:

```typescript
export class KeyDecryptionException extends HttpException {
  readonly reason: DecryptionErrorCode;
  readonly keyId: string;

  constructor(keyId: string, reason: DecryptionErrorCode, detail?: string) {
    super(
      {
        statusCode: 422,
        error: 'Key Decryption Failed',
        message: detail ?? 'Key material could not be decrypted',
        reason,
      },
      422,
    );
    // ...
  }
}
```

**HTTP Response Example:**

```json
{
  "statusCode": 422,
  "error": "Key Decryption Failed",
  "message": "Key material could not be decrypted — the key may be corrupted or the encryption key may have changed",
  "reason": "DECRYPTION_FAILED",
  "timestamp": "2026-06-02T10:15:30.123Z",
  "path": "/internal/key-management/sign",
  "method": "POST"
}
```

**Why 422?**
- Distinguishes client data issues (corrupt key material, stale encryption key) from 500 server errors
- Allows clients to implement retry logic only for transient failures (503, 504) — not decrypt failures
- Aligns with semantic HTTP: the request syntax is valid, but the entity cannot be processed

### 3. Updated `StellarKeyProvider`

**File:** `src/key-management/providers/stellar-key.provider.ts`

**Changes:**
- `sign()` now catches `DecryptionError` and propagates it directly (no wrapping)
- `validateKeyPair()` propagates `DecryptionError` to caller
- Non-decrypt errors (stellar-sdk failures, network timeouts) still throw generic `Error`

**Before:**
```typescript
catch (error) {
  this.logger.error('Signing operation failed:', error);
  throw new Error('Signing failed');
}
```

**After:**
```typescript
catch (error) {
  if (error instanceof DecryptionError) {
    this.logger.error('Key decryption failed during signing:', {
      code: error.code,
      message: error.message,
    });
    throw error; // Propagate to KeyManagementService
  }
  this.logger.error('Signing operation failed:', error);
  throw new Error('Signing failed');
}
```

### 4. Updated `KeyManagementService`

**File:** `src/key-management/key-management.service.ts`

**Changes:**
- `sign()` catches `DecryptionError`, logs with structured context, converts to `KeyDecryptionException`
- `validateKey()` catches `DecryptionError` and converts to `KeyDecryptionException`
- `reEncryptKey()` catches `DecryptionError` and converts to `KeyDecryptionException`
- All decrypt failures are audited with `errorMessage: 'decrypt_failure:{code}'`

**Audit Log Entry Example:**
```json
{
  "operation": "SIGN",
  "keyId": "unknown",
  "publicKey": "GABC123DEFGH",
  "timestamp": "2026-06-02T10:15:30.123Z",
  "success": false,
  "errorMessage": "decrypt_failure:DECRYPTION_FAILED"
}
```

### 5. Updated `KeyManagementController`

**File:** `src/key-management/key-management.controller.ts`

**Changes:**
- Added `POST /internal/key-management/re-encrypt` endpoint for key rotation
- `sign()`, `validateKey()`, and `reEncryptKey()` endpoints automatically propagate `KeyDecryptionException` (422) to clients
- No try/catch needed — NestJS exception filter handles it

### 6. Updated `WalletsService`

**File:** `src/wallets/wallets.service.ts`

**Changes:**
- `getDecryptedPrivateKey()` now throws `KeyDecryptionException` instead of generic `Error`
- Consistent error handling with `KeyManagementService`

**Before:**
```typescript
catch (error) {
  if (error?.code && ['DECRYPTION_FAILED', ...].includes(error.code)) {
    throw new Error('Wallet key decryption failed - possible data corruption');
  }
  // ...
}
```

**After:**
```typescript
catch (error) {
  if (error instanceof DecryptionError) {
    this.logger.error(`Decryption failed for wallet ${walletId}:`, {
      code: error.code,
    });
    throw new KeyDecryptionException(
      walletId,
      error.code,
      'Wallet key decryption failed — the key material may be corrupted or the encryption key may have changed',
    );
  }
  // ...
}
```

## Error Flow

```
EncryptionService.decrypt()
  └─> throws DecryptionError(message, code)
      ↓
StellarKeyProvider.sign()
  └─> catches DecryptionError → propagates unchanged
      ↓
KeyManagementService.sign()
  └─> catches DecryptionError → logs + converts to KeyDecryptionException
      ↓
KeyManagementController.sign()
  └─> KeyDecryptionException propagates automatically (NestJS)
      ↓
Client receives:
  HTTP 422 Unprocessable Entity
  {
    "statusCode": 422,
    "error": "Key Decryption Failed",
    "message": "...",
    "reason": "DECRYPTION_FAILED"
  }
```

## Testing

### Unit Tests

All decrypt failure paths are covered by unit tests:

**`encryption.service.spec.ts`:**
- `DecryptionError` is thrown correctly for invalid data, wrong key, bad tag
- `instanceof DecryptionError` works as expected
- `deserializeFromStorage()` throws `DecryptionError` for malformed JSON

**`stellar-key.provider.spec.ts`:**
- `sign()` propagates `DecryptionError` unchanged (not wrapped)
- `validateKeyPair()` propagates `DecryptionError`
- Non-decrypt errors are still wrapped in generic `Error`

**`key-management.service.spec.ts`:**
- `sign()` converts `DecryptionError` to `KeyDecryptionException`
- `validateKey()` converts `DecryptionError` to `KeyDecryptionException`
- `reEncryptKey()` converts `DecryptionError` to `KeyDecryptionException`
- Audit log records decrypt failures with structured error message
- Non-decrypt errors are NOT converted to `KeyDecryptionException`

**`wallets.service.spec.ts`:**
- `getDecryptedPrivateKey()` throws `KeyDecryptionException` for decrypt failures
- `KeyDecryptionException` has correct `.reason` code and HTTP status

### Running Tests

```bash
# Run all key-management and encryption tests
npm test -- --testPathPattern="encryption|key-management|stellar-key|wallets.service"

# Run with coverage
npm test -- --testPathPattern="encryption|key-management" --coverage
```

## Operational Impact

### Monitoring & Alerting

**Logs to watch:**
```
[KeyManagementService] Key decryption failed during sign for publicKey=GABC123DEFGH...: { code: 'DECRYPTION_FAILED' }
[WalletsService] Decryption failed for wallet wallet-123: { code: 'INVALID_KEY' }
[AUDIT] SIGN - GABC123DEFGH... - FAILED - decrypt_failure:DECRYPTION_FAILED
```

**Alert on:**
- Spike in `decrypt_failure:*` audit log entries
- Multiple `KeyDecryptionException` (422) responses from `/internal/key-management/*`
- `INVALID_KEY` errors after encryption key rotation

### Recovery Procedures

**Scenario 1: Corrupt key material**
- Error: `KeyDecryptionException` with `reason: 'DECRYPTION_FAILED'`
- Cause: Database corruption, bit flip, partial write
- Action:
  1. Check database backup integrity
  2. Restore affected `Wallet.encryptedSecret` from backup
  3. If no backup: Mark wallet as `COMPROMISED`, notify user, provision new wallet

**Scenario 2: Wrong encryption key**
- Error: `KeyDecryptionException` with `reason: 'INVALID_KEY'`
- Cause: `WALLET_ENCRYPTION_KEY` env var changed without re-encrypting stored keys
- Action:
  1. Restore correct `WALLET_ENCRYPTION_KEY` from config management
  2. If old key is lost: All wallets are unrecoverable — initiate disaster recovery
  3. If rotating keys intentionally: Use `/internal/key-management/re-encrypt` to migrate key material

**Scenario 3: Malformed stored data**
- Error: `KeyDecryptionException` with `reason: 'INVALID_DATA'`
- Cause: Bad serialization, JSON truncation, migration bug
- Action:
  1. Inspect `Wallet.encryptedSecret` field in database
  2. Check for incomplete JSON (e.g., missing `iv`, `tag` fields)
  3. If recoverable: Manually fix JSON structure
  4. If not: Treat as corrupt (scenario 1)

## Future Enhancements

1. **Retry with exponential backoff** — For transient KMS/HSM failures (when integrated)
2. **Circuit breaker** — Stop calling decrypt after N consecutive failures
3. **Key material health checks** — Periodic test decrypts on canary wallets
4. **Automated re-encryption** — Background job to migrate keys during encryption key rotation
5. **Metrics export** — Prometheus counters for `decrypt_failure_total{reason="DECRYPTION_FAILED"}`
6. **Alerting thresholds** — PagerDuty alert when decrypt failure rate > 1% over 5 minutes

## Security Considerations

- **No plaintext key leakage:** Crypto error details (e.g., `EVP_DecryptFinal_ex:bad decrypt`) are sanitized out of HTTP responses
- **No key material in logs:** All logging respects "no private key logging" rule — only public keys and error codes are logged
- **Constant-time comparison:** Error paths do not leak timing information about key material validity
- **Audit trail:** Every decrypt failure is recorded in the audit log with timestamp, operation, public key, and reason code

## References

- [NestJS Exception Filters](https://docs.nestjs.com/exception-filters)
- [HTTP 422 Unprocessable Entity](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/422)
- [Node.js crypto module](https://nodejs.org/api/crypto.html)
- [AES-256-GCM](https://en.wikipedia.org/wiki/Galois/Counter_Mode)
