# Idempotency TTL & Cleanup

This document is the operational contract for the `IdempotencyRecord` table
and the TTL cleanup job that prunes it. It complements
[`docs/PAYMENT-DRY-RUN.md`](PAYMENT-DRY-RUN.md), which documents the
idempotency *semantics* on the money path.

---

## Why cleanup exists

Every money-path write that carries an idempotency key inserts a row into
`IdempotencyRecord` so a replayed or retried request returns the original
result instead of creating a duplicate payment or transaction.

That table has a TTL (`expiresAt`, indexed by `@@index([expiresAt])`) but
**nothing removed expired rows**. The table therefore grew without bound: one
row per idempotent write, forever. The consequences are real, not cosmetic:

- **Unbounded storage growth** on the database that also holds wallet custody
  records and the transaction ledger.
- **Degraded index performance** — `expiresAt` lookups get slower as the index
  grows, which slows the very replay-protection path it exists to serve.
- **A confusing forensic surface** — an operator inspecting "was this request
  replayed?" cannot tell a meaningful recent record from a two-year-old one.

The referenced migration
[`prisma/migrations/20260724010000_add_payment_idempotency_key/`](../prisma/migrations/20260724010000_add_payment_idempotency_key/migration.sql)
adds the `idempotencyKey` column and its non-empty check constraint; the TTL
column and its index predate it on `IdempotencyRecord`.

---

## Invariants

Enforced by `src/idempotency/idempotency.service.ts` and covered by
`src/idempotency/idempotency.service.spec.ts`.

1. **TTL is the only expiry rule.** A record is expired when
   `expiresAt < now`. Cleanup must never delete a record whose TTL has not
   elapsed: doing so would re-open the duplicate-write window that idempotency
   exists to close. The query is a strict `lt`, not `lte`.
2. **Bounded batches.** Each pass deletes at most
   `MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE` (10 000) rows. An unbounded `DELETE`
   would hold a long transaction and block concurrent writes on the money path.
3. **Fail-closed on outage.** A database error propagates as
   `IDEMPOTENCY_CLEANUP_DEPENDENCY_UNAVAILABLE`. Cleanup never reports a
   "0 deleted" success it did not achieve — a swallowed outage looks identical
   to "nothing to clean up" and lets the table grow forever.
4. **Replay-safe.** Running cleanup repeatedly or concurrently is safe: each
   pass deletes a disjoint set of rows, so a re-run simply deletes fewer.
5. **No secret leakage.** Return values and logs carry counts and ISO cutoffs
   only — never idempotency keys, cached response bodies, or key material.
6. **Bounded input.** A non-positive or non-integer batch size is rejected with
   `IDEMPOTENCY_CLEANUP_INVALID_BATCH_SIZE` *before* any query is issued.

---

## Configuration

The in-process worker is **opt-in / deny-by-default**: it only starts when
`IDEMPOTENCY_CLEANUP_ENABLED` is exactly `"true"`. This lets a deployment that
prefers an external scheduler (Kubernetes CronJob calling a cron-guarded
endpoint) leave it off, so cleanup runs in exactly one place and cannot be
triggered twice.

| Variable | Default | Description |
|----------|---------|-------------|
| `IDEMPOTENCY_CLEANUP_ENABLED` | `false` | Set to `true` to run the in-process worker |
| `IDEMPOTENCY_CLEANUP_INTERVAL_MS` | `3600000` | How often (ms) to run a cleanup pass |
| `IDEMPOTENCY_CLEANUP_BATCH_SIZE` | `1000` | Rows deleted per pass (clamped to 10000) |

---

## Stable error codes

| Code | Meaning |
|------|---------|
| `IDEMPOTENCY_CLEANUP_DEPENDENCY_UNAVAILABLE` | The database was unreachable; nothing was deleted |
| `IDEMPOTENCY_CLEANUP_INVALID_BATCH_SIZE` | The requested batch size was not a positive integer; no query was issued |

---

## Observability

Ops-safe metrics, emitted with counts only:

- `idempotency.cleanup.deleted` — rows deleted in a pass.
- `idempotency.cleanup.dependency_unavailable` — cleanup passes that failed
  closed because the database was unreachable.
- `idempotency.cleanup.invalid_batch_size` — rejected batch-size requests.

`idempotency.cleanup.dependency_unavailable` is the one to alert on: a
sustained non-zero value means the table is growing again and the money path's
replay protection is at risk from index bloat (not from correctness — an
expired-but-present record is still safe, it just wastes space).

---

## Scheduling

Recommended cadence is hourly, aligned with the default
`IDEMPOTENCY_CLEANUP_INTERVAL_MS`. Hourly is chosen so a single missed tick
costs at most one hour of extra rows, which is negligible against the table's
growth rate, while keeping the `DELETE` small and short-lived.

If you run cleanup from an external scheduler instead, keep the
`X-Cron-Secret` guard described in
[`docs/CRON-SCHEDULES.md`](CRON-SCHEDULES.md) and set
`IDEMPOTENCY_CLEANUP_ENABLED=false` so the in-process worker does not also run.

---

## Rollback

- **Stop cleanup:** set `IDEMPOTENCY_CLEANUP_ENABLED=false` and restart, or
  remove the scheduler trigger. This is safe at any time — leaving expired
  rows in place is a storage concern, never a correctness one, because
  idempotency lookups are already TTL-checked on read.
- **Revert the code:** a plain revert. No data migration is required; rows
  already deleted stay deleted and are not needed for correctness.
- **Mainnet safety:** cleanup only ever *deletes expired* rows. It can never
  delete a live record, so it cannot cause a duplicate payment on the money
  path under any configuration.

---

## References

- [`docs/PAYMENT-DRY-RUN.md`](PAYMENT-DRY-RUN.md) — payment idempotency
  semantics and error contract.
- [`prisma/migrations/20260724010000_add_payment_idempotency_key/`](../prisma/migrations/20260724010000_add_payment_idempotency_key/migration.sql)
- `src/idempotency/idempotency.service.ts` — cleanup implementation.
- `src/idempotency/idempotency-cleanup.worker.ts` — scheduled worker.
- `src/idempotency/idempotency.service.spec.ts` — invariant and auth-negative
  coverage.
- [`SECURITY.md`](../SECURITY.md) — fail-closed and secret-handling policy.
