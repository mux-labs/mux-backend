# Per-Developer API Quotas

The per-API-key rate limit is **not a tenant boundary**. A developer can hold
many keys across many projects, and a client that rotates keys — or simply owns
several — can blow past an intended aggregate limit while every individual key
stays comfortably under its own. The limit an operator actually means when they
say "this developer may make N requests a minute" has to be enforced at the
developer, summed across every key and project that developer owns.

`RateLimitService` and `DeveloperQuotaGuard` (`src/rate-limit/`) implement that
aggregate boundary. It is **in addition to** the existing per-key limit, never
instead of it.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DEVELOPER_QUOTAS_ENABLED` | `false` | Master switch. Only the exact string `true` (or `1`) turns quotas on. |
| `DEVELOPER_QUOTA_DEFAULT_RPM` | `600` | Requests per window for a developer with no explicit quota. Clamped to `[1, DEVELOPER_QUOTA_MAX_RPM]`. |
| `DEVELOPER_QUOTA_WINDOW_MS` | `60000` | Sliding-window length. |
| `DEVELOPER_QUOTA_MAX_RPM` | `10000` | Hard ceiling on any quota. Lowering it below the default tightens every quota at once — the emergency brake. It is itself clamped, so the ceiling cannot be raised by configuration alone. |

`RateLimitRecord` cleanup is configured separately by
`RATE_LIMIT_CLEANUP_ENABLED`, `RATE_LIMIT_CLEANUP_INTERVAL_MS`, and
`RATE_LIMIT_CLEANUP_BATCH_SIZE`.

## Invariants

1. **Deny-by-default.** Quotas are **off** unless `DEVELOPER_QUOTAS_ENABLED` is
   explicitly `true`. A deployment that has not opted in behaves exactly as
   before, and turning it off restores that behaviour immediately.
2. **Keyed on the server-resolved developer.** The guard reads
   `request.apiKey.developer.id` — the principal the API key guard already
   validated. It never reads a `developerId` from the body or query string. A
   client cannot borrow another developer's quota or escape its own by claiming
   a different id. There is deliberately **no fallback** to a client-supplied id
   "only when the key is missing", because that is the same hole.
3. **Sliding window, counted per developer.** All of a developer's keys and
   projects share one counter. Capacity frees as individual requests age out of
   the window, not on a fixed boundary.
4. **Fails closed on an unattributed request.** With quotas on and no resolved
   developer, the request is refused: an unaccounted request cannot be proven to
   be within anyone's quota.
5. **Bounded both ways.** The limit is clamped to a sane range and the tracked
   developer map is capped at 10 000 entries. Eviction costs a developer a fresh
   window, never a denial — so a flood of distinct ids degrades accounting
   accuracy rather than availability.
6. **Actionable, non-leaking 429.** The response carries
   `DEVELOPER_QUOTA_EXCEEDED`, `Retry-After`, and `X-RateLimit-Limit` /
   `X-RateLimit-Remaining`. It never echoes a key, a developer id, or a body.
7. **No secret leakage in logs.** Counters, limits, and window bounds only.

## Response

```json
HTTP/1.1 429 Too Many Requests
Retry-After: 42
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 0

{
  "errorCode": "DEVELOPER_QUOTA_EXCEEDED",
  "message": "Developer quota exceeded. Please try again later.",
  "retryAfterSeconds": 42
}
```

Branch on `errorCode`, not on the message.

## Metrics

Ops-safe counters with no user-derived labels:

- `developer_quota_admitted` — request allowed
- `developer_quota_exceeded` — quota hit
- `developer_quota_denied_unattributed` — refused for want of a resolved developer
- `developer_quota_window_evicted` — tracked-developer map hit its cap
- `developer_quota_cleanup_deleted` / `_dependency_unavailable` — cleanup

## Cleanup

`RateLimitCleanupWorker` prunes `RateLimitRecord` rows whose window has closed.
Like the idempotency cleanup worker it is **opt-in**, has a re-entrancy guard
against overlapping ticks, deletes only rows with `windowStart < now - windowMs`
(so a current-window row is never removed while it is still enforcing a limit),
bounds each batch, and **fails closed** on a database outage rather than
reporting a false "0 deleted". It is not exported from `RateLimitModule`: it is
an internal detail, not public API.

## Known limitation

Counters are **in-process**. With more than one API instance the effective limit
is per instance, not global, so N instances admit roughly N × limit. That is
acceptable for a coarse abuse boundary (which is what this is for) but it is not a
hard global cap. A shared store (Redis) is the fix if a global cap is ever
required; the `RateLimitService` interface is the seam for it.

## Rollback

Set `DEVELOPER_QUOTAS_ENABLED=false` and restart. No schema change, no
migration, and no data to unwind — the quota is pure request-path accounting.
Turning it off restores the previous per-key-only behaviour exactly.

## Tests

- `src/rate-limit/rate-limit.service.spec.ts` — config clamping, window
  behaviour, cleanup, and the guard including the authz negatives
- `test/rate-limit-cleanup-worker.e2e-spec.ts` — worker wiring and DI

Related: [FEATURE-FLAGS.md](FEATURE-FLAGS.md), [../SECURITY.md](../SECURITY.md).

---
