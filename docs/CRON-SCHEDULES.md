# Cron Schedules & Runbook

This document is the source of truth for **every scheduled (cron-triggered)
job** in `mux-backend`: which endpoints exist, how often they are meant to run,
how they are authenticated, and what an operator must do when one fails.

It complements — and does not replace — [`SECURITY.md`](../SECURITY.md)
(§ *Internal Cron Jobs & Secret Guard*), which defines the access-control and
secret-handling policy that every job below inherits.

---

## Invariants

These hold for **every** internal job. They are asserted by
`test/cron-schedule-docs.e2e-spec.ts` (#961).

1. **Not public API.** Internal jobs are never part of the documented public
   surface. They live under an `/internal` route prefix (or an equivalent
   explicitly-internal path) and are not advertised as public examples.
2. **Deny-by-default.** A request is rejected **before any job logic runs** when
   `CRON_SECRET` is unset, when the `X-Cron-Secret` header is missing, or when the
   presented value does not match. There is no implicit allow path, no default
   credential, and no environment (including `NODE_ENV=production`) that relaxes
   this.
3. **Constant-time comparison.** The presented secret is compared with
   `crypto.timingSafeEqual` so response timing cannot be used to recover the
   secret byte-by-byte.
4. **No secret leakage.** The secret, derived key material, JWTs, and webhook
   secrets never appear in logs, error responses, or metric labels. Auth failures
   are logged with a correlation/request id and a stable error code only.
5. **Idempotent / replay-safe.** Replayed, overlapping, or duplicated triggers must
   not produce duplicate side effects. Each job documents its idempotency key
   below.
6. **Fail-closed on dependency outage.** On DB / RPC / Horizon outage, internal
   **write** paths reject rather than partially applying. Read-only jobs may
   return an empty result but must never report a success that did not happen.
7. **No cross-tenant escalation.** Internal jobs operate with elevated
   cross-tenant privilege; that privilege is reachable *only* through the cron
   secret and never through a project API key or JWT.
8. **Bounded input.** Every job that accepts a `limit`/batch parameter clamps it
   to a documented maximum so an oversized or adversarial payload cannot cause a
   resource-exhaustion (griefing) event.

---

## Authentication

| Item | Value |
|------|-------|
| Header | `X-Cron-Secret` (case-insensitive; `x-cron-secret` is also accepted) |
| Config key | `CRON_SECRET` |
| Comparison | `crypto.timingSafeEqual` (constant-time) |
| Failure response | `401 Unauthorized`, stable error code, correlation id |

`CRON_SECRET` must be a high-entropy random value (32+ bytes, base64/hex
encoded) supplied only via the environment / secret manager. It must never be
committed, logged, or returned in an error body. The rotation procedure lives in
[`SECURITY.md`](../SECURITY.md#rotation).

---


## Schedule reference

Schedules are **recommendations for the external scheduler** (Kubernetes
CronJob, GitHub Actions schedule, platform cron, …). The backend does not embed
a timer for HTTP-triggered jobs — the scheduler owns the cadence, and the
backend owns correctness. Cadences are chosen so that a single missed or
overlapping tick is harmless (see *Failure modes*).

| Endpoint | Method | Recommended cadence | Idempotency key | Side effects | Max batch |
|----------|--------|---------------------|-----------------|--------------|-----------|
| `/v1/transactions/internal/poll-pending` | `POST` | Every 1 minute | Natural key: transaction `id` + status transition (DB-guarded update) | Yes — confirms/fails `PENDING` transactions from Horizon | `limit`, default `100`, **max `1000`** |
| `/v1/transactions/internal/relayer-funding/check` | `POST` | Every 15 minutes | Natural key: `walletId` + network; funding is threshold-guarded | Yes — may request testnet funds | n/a (single wallet per call) |
| `/v1/transactions/internal/stuck-pending` | `GET` | Every 15 minutes (read-only) | n/a (read-only) | No | `limit`, default `100`, **max `1000`** |
| `/v1/backup/health` | `GET` | Daily | n/a (read-only) | No | n/a |
| `/v1/backup/metadata` | `POST` | Daily | `Idempotency-Key` header (e.g. `backup-$(date +%F)`) | Yes — records backup metadata | n/a |
| `/v1/backup/drill` | `POST` | Monthly | `Idempotency-Key` header (e.g. `drill-$(date +%F)`) | Yes — runs a restore drill | n/a |
| `/v1/backup/procedures` | `GET` | Daily | n/a (read-only) | No | n/a |

In-process cleanup workers (not HTTP-triggered) are documented separately:

| Worker | Cadence | Config |
|--------|---------|--------|
| `RateLimitCleanupWorker` | Every 60 minutes | `RATE_LIMIT_CLEANUP_INTERVAL_MS`, `RATE_LIMIT_CLEANUP_OLDER_THAN_MS` |

Any new scheduled job MUST be added to the table above **and** to the contract
test in the same PR, so the documented surface cannot silently drift from the
implemented surface.

---

## Per-job notes

### `POST /v1/transactions/internal/poll-pending`

- **Purpose:** reconcile `PENDING` transactions against Horizon and move them to
  `CONFIRMED` / `FAILED`.
- **Why every minute:** confirmation latency is user-visible. A missed tick
  delays confirmation by one interval; it cannot double-confirm, because the
  update only applies to rows still in `PENDING` and the status change is
  written under a DB-level guard.
- **Overlapping ticks:** safe. Two concurrent polls contend on the same rows and
  the loser observes them already updated — no duplicate Horizon submission and
  no duplicate status-change event.
- **Bounded input:** `limit` defaults to `100` and is clamped to `1000`. A caller
  cannot request an unbounded batch.

### `POST /v1/transactions/internal/relayer-funding/check`

- **Purpose:** check a relayer (fee-source) wallet's native balance and, on
  TESTNET only, request testnet funds when it is below the minimum.
- **Mainnet safety:** on MAINNET the job only raises a low-balance alert. It
  never moves funds, and it never calls the testnet faucet while
  `STELLAR_NETWORK=MAINNET`/`PUBLIC`. A testnet/mainnet misconfiguration is
  rejected fail-closed rather than silently funding on the wrong network.
- **`walletId` is required:** a missing/blank `walletId` is a `400`, evaluated
  *after* authentication, so an unauthenticated caller cannot use the endpoint
  as an existence oracle.

### `GET /v1/transactions/internal/stuck-pending`

- **Purpose:** list transactions stuck in `PENDING` beyond a threshold. This is a
  **read-only** diagnostic and is the recommended first call when investigating
  a stalled confirmation.
- **Bounded input:** `thresholdMinutes` (default `60`, min `1`), `limit`
  (default `100`, max `1000`), `offset` (default `0`).

### `POST /v1/backup/*`

- **Purpose:** backup health, metadata capture, and restore drills. Full request
  and response contracts are in
  [`docs/BACKUP_RESTORE_PROCEDURES.md`](BACKUP_RESTORE_PROCEDURES.md).
- **Idempotency:** the write endpoints (`metadata`, `drill`) take an
  `Idempotency-Key` header so a retried or duplicated trigger does not record
  two backups or run two drills.

---

## Failure modes & safe replay

| Situation | Expected behavior | Operator action |
|-----------|-------------------|-----------------|
| Secret rotated, scheduler not yet updated | Every trigger returns `401`; no job logic runs (fail-closed — jobs stop, they are never exposed) | Complete the rotation steps in `SECURITY.md`, then re-verify |
| `CRON_SECRET` unset | All triggers return `401`; logs a warning that cron requests are being denied | Restore the secret via secret manager; do **not** add a fallback value |
| DB / Horizon outage during `poll-pending` | No partial status updates; the job reports the error and the next tick retries the untouched rows | Check Horizon reachability; the job is safe to leave scheduled |
| Duplicate / overlapping trigger | No duplicate side effects (natural-key or `Idempotency-Key` guard) | None |
| Oversized `limit` / batch | Clamped to the documented maximum | None; fix the caller if it needs more headroom |
| Testnet vs mainnet misconfiguration | Faucet path refuses to run on MAINNET; only a low-balance alert is raised | Correct `STELLAR_NETWORK` |

**Safe replay:** every job in the table is safe to re-trigger after a failure.
For a partially-completed restore drill, re-run with the same `Idempotency-Key`
and follow the restore runbook rather than re-issuing ad hoc production
operations.

---

## Adding a new scheduled job

1. Put the route behind the cron secret guard. Do not add a second
   authentication path, and do not accept a project API key or JWT as a
   substitute.
2. Give it a natural-key or `Idempotency-Key` guard so replay cannot duplicate
   side effects.
3. Clamp every batch/size parameter to a documented maximum.
4. Fail closed on dependency outage for any write path.
5. Add a row to the **Schedule reference** table above **and** a case to
   `test/cron-schedule-docs.e2e-spec.ts`, in the same PR.
6. Cross-link the runbook from `README.md` and `SECURITY.md`.

---

## Observability

- Auth failures are logged with a correlation/request id, the request path, and
  the source IP. **Never** the secret value.
- Job outcomes are returned as coarse counters/summaries so the scheduler can
  alert on `processed`/`confirmed`/`failed` deltas without exposing payloads.
- Rate-limit records for internal callers are pruned by
  `RateLimitCleanupWorker`; see `README.md` § *Rate-Limit Record Cleanup*.

---

## Rollback

This document and its contract test are documentation/CI only. They do not
change runtime behavior, so rollback is a plain revert with no data migration,
no config change, and no mainnet impact. To **disable** internal jobs
operationally (rather than reverting code), rotate or unset `CRON_SECRET`: the
guard is fail-closed, so jobs stop being triggered instead of becoming
reachable.

---

## References

- [`SECURITY.md`](../SECURITY.md) — internal cron secret guard, rotation, and
  production security requirements.
- [`docs/BACKUP_RESTORE_PROCEDURES.md`](BACKUP_RESTORE_PROCEDURES.md) — backup
  and restore drill runbook.
- [`docs/verify-scripts-runbook.md`](verify-scripts-runbook.md) — fail-closed
  verification gates.
- `test/cron-schedule-docs.e2e-spec.ts` — contract test for this document.
- `test/cron-secret-guard.e2e-spec.ts`,
  `test/transactions-internal-cron-guard.e2e-spec.ts`,
  `test/backup-module-registered.e2e-spec.ts` — guard enforcement tests.

---
