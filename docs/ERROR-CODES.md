# Error Code Catalog (#949)

Every failed API request returns the same envelope, including a stable,
machine-readable `errorCode`:

```json
{
  "statusCode": 503,
  "timestamp": "2026-09-26T13:00:00.000Z",
  "path": "/v1/balances/wallet/w1/sync",
  "method": "POST",
  "message": "A required dependency (Horizon/RPC/database) is unavailable; no write was applied.",
  "error": "Service Unavailable",
  "errorCode": "DEPENDENCY_UNAVAILABLE",
  "requestId": "3f1c9b2e-8a4d-4c1e-9f2a-1b2c3d4e5f60"
}
```

Frontends should **branch on `errorCode`, never on `message`** (messages are
localised/sanitised and may change) and should always surface `requestId` to
support when a user reports a problem.

## Machine-readable source of truth

```
GET /v1/error-codes
```

Public, read-only, cacheable (`Cache-Control: public, max-age=300`), and
secret-free. Response:

```json
{
  "schemaVersion": 1,
  "codes": [
    {
      "code": "DEPENDENCY_UNAVAILABLE",
      "httpStatus": 503,
      "category": "dependency",
      "retryable": true,
      "action": "RETRY_WITH_BACKOFF",
      "message": "A required dependency (Horizon/RPC/database) is unavailable; no write was applied."
    }
  ]
}
```

Use it to generate client constants instead of hard-coding strings:

```ts
const catalog = await fetch(`${API}/v1/error-codes`).then((r) => r.json());
const byCode = new Map(catalog.codes.map((c) => [c.code, c]));
// …later, given an API error envelope `err`:
const entry = byCode.get(err.errorCode);
if (entry?.retryable) scheduleRetry(entry.action === 'RETRY_IDEMPOTENT');
```

`schemaVersion` is bumped only for a **breaking** change to the entry shape;
adding a new code is not breaking.

## Client actions

| `action` | What the client should do |
|----------|---------------------------|
| `FIX_REQUEST` | Show field/validation errors. Do not retry — the request is wrong. |
| `REAUTHENTICATE` | Credentials are missing/invalid. Send the user to login. |
| `REFRESH_TOKEN` | Access token expired. Refresh once, then re-auth on failure. |
| `REQUEST_ROLE` | Authenticated but not permitted. Hide/disable the action. |
| `RETRY_WITH_BACKOFF` | Same call may succeed later; back off and retry. |
| `RETRY_IDEMPOTENT` | Retry only with the **same** idempotency key. |
| `WAIT_AND_RETRY` | A resource is busy (backup/export/restore); retry after backoff. |
| `CONTACT_SUPPORT` | Surface `requestId` to support; the client cannot fix it. |

## Codes

Codes are **append-only**: never rename or repurpose one. A unit test asserts
the catalog documents every member of `ErrorCode` exactly once and that its
`httpStatus` matches the envelope builder
(`src/common/error-code-catalog/error-code-catalog.spec.ts`).

| Code | HTTP | Category | Retryable | Action |
|------|------|----------|-----------|--------|
| `BAD_REQUEST` | 400 | client | no | FIX_REQUEST |
| `UNAUTHORIZED` | 401 | auth | no | REAUTHENTICATE |
| `FORBIDDEN` | 403 | authorization | no | REQUEST_ROLE |
| `NOT_FOUND` | 404 | client | no | FIX_REQUEST |
| `CONFLICT` | 409 | conflict | no | FIX_REQUEST |
| `UNPROCESSABLE_ENTITY` | 422 | client | no | FIX_REQUEST |
| `TOO_MANY_REQUESTS` | 429 | rate_limit | yes | RETRY_WITH_BACKOFF |
| `INTERNAL_ERROR` | 500 | server | yes | CONTACT_SUPPORT |
| `SERVICE_UNAVAILABLE` | 503 | dependency | yes | RETRY_WITH_BACKOFF |
| `INVALID_CREDENTIALS` | 401 | auth | no | REAUTHENTICATE |
| `TOKEN_EXPIRED` | 401 | auth | no | REFRESH_TOKEN |
| `DELEGATE_REVOKED` | 403 | authorization | no | REQUEST_ROLE |
| `INSUFFICIENT_ROLE` | 403 | authorization | no | REQUEST_ROLE |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | idempotency | no | FIX_REQUEST |
| `IDEMPOTENCY_CONFLICT` | 409 | idempotency | no | RETRY_IDEMPOTENT |
| `DEPENDENCY_UNAVAILABLE` | 503 | dependency | yes | RETRY_WITH_BACKOFF |
| `WRITE_REJECTED` | 503 | dependency | yes | RETRY_WITH_BACKOFF |
| `SHUTDOWN_IN_PROGRESS` | 503 | dependency | yes | RETRY_WITH_BACKOFF |
| `KEY_DECRYPT_FAILED` | 503 | custody | no | CONTACT_SUPPORT |
| `KEY_VERSION_UNSUPPORTED` | 503 | custody | no | CONTACT_SUPPORT |
| `EXPORT_JOB_NOT_FOUND` | 404 | export | no | FIX_REQUEST |
| `EXPORT_NOT_READY` | 409 | export | yes | WAIT_AND_RETRY |
| `EXPORT_DOWNLOAD_FORBIDDEN` | 403 | export | no | REQUEST_ROLE |
| `EXPORT_DOWNLOAD_EXPIRED` | 410 | export | no | FIX_REQUEST |
| `EXPORT_TOO_LARGE` | 413 | export | no | FIX_REQUEST |
| `BACKUP_NOT_FOUND` | 404 | backup | no | FIX_REQUEST |
| `BACKUP_NOT_READY` | 409 | backup | yes | WAIT_AND_RETRY |
| `BACKUP_IN_PROGRESS` | 409 | backup | yes | WAIT_AND_RETRY |
| `BACKUP_INTEGRITY_FAILED` | 422 | backup | no | CONTACT_SUPPORT |
| `RESTORE_FORBIDDEN` | 403 | backup | no | REQUEST_ROLE |
| `RESTORE_CONFLICT` | 409 | backup | no | CONTACT_SUPPORT |
| `RESTORE_IN_PROGRESS` | 409 | backup | yes | WAIT_AND_RETRY |
| `RESTORE_POINT_INVALID` | 422 | backup | no | FIX_REQUEST |
| `VALIDATION_FAILED` | 422 | client | no | FIX_REQUEST |
| `UNAUTHENTICATED` | 401 | auth | no | REAUTHENTICATE |
| `RATE_LIMITED` | 429 | rate_limit | yes | RETRY_WITH_BACKOFF |

## Security notes

* The catalog is static and contains **no** tenant data, key material, tokens, or
  upstream detail. It is allowlisted as a public endpoint
  (`src/common/filters/http-exception.filter.ts`,
  `src/common/interceptors/request-id.interceptor.ts`).
* In production, `message` on `5xx` responses is replaced with a generic string
  and every payload passes through secret redaction — a leaked connection
  string, JWT, or Stellar secret can never reach a browser.

See also: [README § Error responses](../README.md#error-responses),
[docs/AUTH-FEATURE-FLAGS.md](AUTH-FEATURE-FLAGS.md).
