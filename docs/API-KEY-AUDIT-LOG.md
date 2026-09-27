# API Key Audit Log

Every API key authentication decision is a security event. A key that starts
working, a key that stops working, and a spray of invalid keys all have to be
reconstructable by an operator **without ever exposing key material**.

`ApiKeyAuditService` (`src/api-keys/api-key-audit.service.ts`) is the
append-only trail behind that, and `ApiKeyGuard` writes to it on every decision.

## What is recorded

| Action | Emitted when | Extra fields |
|--------|--------------|--------------|
| `API_KEY_VALIDATED` | The presented key resolved to an active key | `apiKeyId`, `developerId`, `projectId` |
| `API_KEY_REJECTED` | The key was refused | `reason` |
| `API_KEY_VALIDATION_UNAVAILABLE` | The key store could not be reached | — |

`reason` is a stable code, never prose: `MISSING`, `MALFORMED`, `UNKNOWN`,
`REVOKED`, `EXPIRED`, `SUSPENDED`. Match on the code; the log message is for
humans and may change.

Every event also carries `route` (`METHOD /path`, query string stripped), `ip`,
`correlationId`, and an ISO-8601 `at` timestamp.

## Invariants

1. **No key material, ever.** The presented key is hashed with SHA-256 and only
   the first 12 hex characters are kept as `fingerprint`. The plaintext key is
   not stored, returned, or logged. A fingerprint is safe to put in an alert and
   useless to an attacker.
2. **Fingerprints are compared in constant time** (`ApiKeyAuditService.sameKey`
   uses `crypto.timingSafeEqual`) so the audit trail cannot become a timing
   oracle on the key itself.
3. **Bounded, sanitized fields.** Every value is truncated to 128 characters and
   stripped of control characters before it is stored or logged, so a hostile
   `Authorization` header or path cannot forge a log line in an operator's
   terminal.
4. **The audit sink never changes the outcome.** `ApiKeyGuard.auditDecision` is
   fail-soft: if the sink throws, the request proceeds (or fails) exactly as it
   would have without auditing. An audit-sink outage must not turn a valid
   request into a 500, and must not mask the real authentication decision.
5. **Bounded buffer.** The in-process ring buffer holds at most 500 events, so
   an attacker spraying invalid keys cannot grow it without limit. It is a
   debugging aid for the current process, not a compliance store — durable
   retention is the log shipper's job.
6. **Correlatable.** `correlationId` is reused from the inbound `x-request-id`
   when well-formed (via `resolveRequestId`), otherwise generated. An audit line,
   a request log line, and a client-side report can be joined.

## Fail-closed behaviour

A dependency outage (DB, key store) is **not** reported as "invalid key". The
guard surfaces `503 Service Unavailable` with
`API key validation service unavailable` and audits
`API_KEY_VALIDATION_UNAVAILABLE`. An upstream `401` (expired/revoked key) is
preserved as a `401` rather than being masked as an outage. In every failure
path nothing is attached to the request — deny-by-default.

## Metrics

Ops-safe counters, no labels derived from user input:

- `apikey_audit_api_key_validated`
- `apikey_audit_api_key_rejected`
- `apikey_audit_api_key_validation_unavailable`
- `apikey_audit_reason_<reason>` (e.g. `apikey_audit_reason_expired`)

A sustained rise in `apikey_audit_reason_unknown` is the signal to alert on: it
is what a key spray or a leaked-key enumeration looks like.

## Wiring

`ApiKeyAuditService` is provided by `AppModule` and by `SorobanInvokeModule` (so
the Soroban surface is audited too). In `ApiKeyGuard` it is injected with
`@Optional()`, so a module that has not wired the sink still constructs — the
guard simply skips auditing rather than failing to boot.

## Tests

- `src/api-keys/api-key-audit.service.spec.ts` — fingerprinting, sanitization,
  buffer bounds, metrics.
- `src/api-keys/api-key.guard.spec.ts` — guard/audit integration, fail-closed
  paths, sink-failure containment.
- `test/api-key-audit-log.e2e-spec.ts` — end-to-end through the Nest DI container.

## Rollback

The audit service is read-only observability: it performs no writes to the
database or the chain, and no authz decision depends on it. Reverting this
change removes the audit trail and nothing else; there is no schema, migration,
or feature flag to unwind. If the trail is ever too noisy, raise
`MAX_AUDIT_BUFFER_SIZE` or drop the guard's audit calls — the surface keeps
working either way.

Related: [KEY-MANAGEMENT-SUMMARY.md](KEY-MANAGEMENT-SUMMARY.md),
[../SECURITY.md](../SECURITY.md).

---

