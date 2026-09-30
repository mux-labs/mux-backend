# Failed Migration Recovery Runbook

## Overview

This runbook provides procedures for detecting, diagnosing, and recovering
from failed database migrations in the Mux Backend API.

It is the document an engineer opens while a migration is wedged and the API
will not start. **Rehearse it before you need it** — the tabletop exercise in
[`docs/migration-recovery-tabletop.md`](./migration-recovery-tabletop.md) walks
every scenario below and is enforced by
`test/migration-recovery-tabletop.e2e-spec.ts`.

> **Package manager:** this repo mandates pnpm (`preinstall: only-allow pnpm`).
> Every command below uses pnpm. An `npm run …` line is a copy-paste trap.

> **Key management migrations:** for the custody key-management migration path
> (versioned key envelopes, fail-closed decrypt, authz), see
> [`docs/MIGRATION-KEY-MANAGEMENT.md`](./MIGRATION-KEY-MANAGEMENT.md),
> [`docs/key-management-consolidation.md`](./key-management-consolidation.md),
> and [`docs/custody-security-model.md`](./custody-security-model.md).

## Quick Reference

| Scenario | Steps | Recovery Time |
|----------|-------|---------------|
| Migration hangs | Check logs → Kill process → Rollback | 5-10 min |
| Syntax error | Fix schema → Rollback → Retry | 10-15 min |
| Constraint violation | Backfill data → Rollback → Retry | 15-30 min |
| Lock timeout | Kill blocking query → Retry | 5 min |
| Key envelope migration failure | Halt writes → Verify version → Rollback → Retry | 15-30 min |

**Tabletop:** [`docs/migration-recovery-tabletop.md`](./migration-recovery-tabletop.md)
— run it quarterly and after any change to the migration tooling.

## Invariants (must hold at all times)

These hold for every scenario below. If a recovery step would violate one,
that step is wrong — stop and escalate.

1. **Server is the source of truth.** Spends, recovery, and admin actions are
   authorized server-side; clients cannot bypass policy.
2. **Fail-closed on dependency outage.** If the DB, RPC, or Horizon is
   unavailable, writes MUST fail with a stable error code — never partially
   apply or silently succeed.
3. **Idempotency.** Replayed requests with the same idempotency key return the
   original result and do not re-apply.
4. **No secret leakage.** Logs and metrics never contain raw key material,
   JWTs, or webhook secrets — only correlation ids, wallet ids, and version
   numbers.
5. **Deny-by-default.** Privileged surfaces require explicit
   owner/delegate/guardian/API-key/JWT authorization. Wrong role, expired auth,
   and revoked delegates are rejected.
6. **No key-version downgrade.** `wallet_key_version` only increases. Reverting
   to an older envelope is how a rotation destroys the only copy of a key.

---

## Detection

### Signs of migration failure

1. **Application startup fails** with a migration error.
2. **Database logs** show:
   - `ERROR: relation "table_name" already exists`
   - `ERROR: column "column_name" does not exist`
   - `deadlock detected`
   - `statement timeout`
3. **Metrics** show a stuck migration: a long-running transaction in
   `pg_stat_activity`, and no progress on the migration commit.

### Check migration status

```bash
# List applied migrations
pnpm exec prisma migrate status

# Find stuck (started but never finished) migrations
psql -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT name, started_at FROM _prisma_migrations WHERE finished_at IS NULL;"

# Check long-running transactions
psql -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT pid, xact_start, state FROM pg_stat_activity WHERE state = 'active' AND xact_start < NOW() - INTERVAL '5 minutes';"
```

---

## Recovery Procedures

> **Before any of the scenarios below:** halt writes to the affected surface
> (feature flag / kill-switch) and scale the API down, so nothing writes against
> a half-migrated schema.

### Scenario 1: Syntax error in migration

**Symptoms:**
- `ERROR: syntax error at or near...`
- Migration marked as started but not finished.

**Steps:**

1. **Stop the application** so nothing writes against a partial schema.
   ```bash
   kubectl scale deployment mux-api --replicas=0
   ```

2. **Identify the failed migration.**
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" \
     -c "SELECT name FROM _prisma_migrations WHERE finished_at IS NULL;"
   ```

3. **Confirm it is safe to mark rolled back** — i.e. the migration did not
   partially apply. Check the target columns/tables actually exist before
   deciding; a migration that *did* apply must be reconciled, not discarded.
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" \
     -c "SELECT column_name FROM information_schema.columns WHERE table_name = '<table>';"
   ```

4. **Mark the migration rolled back.** Prisma does not roll back for you.
   ```bash
   pnpm exec prisma migrate resolve --rolled-back <migration-name>
   ```

5. **Fix the migration SQL** in
   `prisma/migrations/<timestamp>_<name>/migration.sql`.

6. **Retry the migration.**
   ```bash
   pnpm prisma:migrate:prod
   ```

7. **Restart the application** and confirm `/v1/ready` reports ready.
   ```bash
   kubectl scale deployment mux-api --replicas=3
   ```

### Scenario 2: Constraint violation

**Symptoms:**
- `ERROR: duplicate key value violates unique constraint`
- `ERROR: insert or update on table violates foreign key constraint`

**Steps:**

1. **Analyse the violation** before changing any data.
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT * FROM <table> WHERE <condition>;"
   ```

2. **Fix the conflicting data** (backfill or cleanup), in bounded batches so a
   large table does not hold a lock for the length of the backfill.
   ```sql
   -- Example: remove duplicates before adding a UNIQUE constraint
   DELETE FROM <table> WHERE id NOT IN (
     SELECT MIN(id) FROM <table> GROUP BY <unique_col>
   );
   ```

3. **Roll back the migration.**
   ```bash
   pnpm exec prisma migrate resolve --rolled-back <migration-name>
   ```

4. **Retry after the data fix.**
   ```bash
   pnpm prisma:migrate:prod
   ```

### Scenario 3: Lock timeout

**Symptoms:**
- `ERROR: canceling statement due to lock timeout`
- `statement timeout` in logs

**Steps:**

1. **Identify blocking queries.**
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT blocked_locks.pid AS blocked_pid, blocked_locks.relation::regclass, blocking_locks.pid AS blocking_pid FROM pg_locks blocked_locks JOIN pg_locks blocking_locks ON blocked_locks.locktype = blocking_locks.locktype AND blocked_locks.database IS NOT DISTINCT FROM blocking_locks.database AND blocked_locks.relation IS NOT DISTINCT FROM blocking_locks.relation AND blocked_locks.page IS NOT DISTINCT FROM blocking_locks.page AND blocked_locks.tuple IS NOT DISTINCT FROM blocking_locks.tuple AND blocked_locks.virtualxid IS NOT DISTINCT FROM blocking_locks.virtualxid AND blocked_locks.transactionid IS NOT DISTINCT FROM blocking_locks.transactionid AND blocked_locks.classid IS NOT DISTINCT FROM blocking_locks.classid AND blocked_locks.objid IS NOT DISTINCT FROM blocking_locks.objid AND blocked_locks.objsubid IS NOT DISTINCT FROM blocking_locks.objsubid AND blocked_locks.granted AND NOT blocking_locks.granted WHERE NOT blocked_locks.granted;"
   ```

2. **Terminate the blocking transaction.** This rolls back a *user's*
   in-flight transaction — confirm with the owning team before doing it on a
   live table.
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" \
     -c "SELECT pg_terminate_backend(<pid>) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active';"
   ```

3. **Increase `lock_timeout` (temporary)** and retry.
   ```sql
   SET lock_timeout = '30 seconds';
   ```

4. **Retry the migration.**
   ```bash
   pnpm prisma:migrate:prod
   ```

### Scenario 4: Hung migration

**Symptoms:**
- Migration started hours ago, no errors in logs, application waiting.

**Steps:**

1. **Check migration status.**
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" \
     -c "SELECT * FROM _prisma_migrations WHERE finished_at IS NULL AND started_at < NOW() - INTERVAL '1 hour';"
   ```

2. **Identify the long-running transaction.**
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" \
     -c "SELECT pid, usename, xact_start, state_change, query FROM pg_stat_activity WHERE xact_start < NOW() - INTERVAL '1 hour';"
   ```

3. **Terminate the stuck transaction.**
   ```bash
   psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT pg_terminate_backend(<pid>);"
   ```

4. **Mark the migration rolled back.**
   ```bash
   pnpm exec prisma migrate resolve --rolled-back <migration-name>
   ```

5. **Investigate the root cause before retrying:** missing indexes, disk space,
   lock contention.

---

## Key envelope migration failure

The custody key-envelope path is the expensive failure: a wedged migration
overlapping a key rotation, with money on the line.

**Symptoms:** `KEY_DECRYPT_FAILED` or `KEY_VERSION_UNKNOWN` in the logs, and
writes to the money path failing closed.

**Recovery procedure:**

1. **Halt writes** via the kill-switch (`KEY_MIGRATION_ENABLED`,
   `KEY_ROTATION_ENABLED`) before touching data. See
   [`docs/FEATURE-FLAGS.md`](./FEATURE-FLAGS.md).
2. **Verify the envelope versions** — the failing wallet's version must be
   known, and it must not be higher than the current version.
3. **Never re-enable an older key version to "unblock" writes.** A version
   downgrade is refused by design; forcing it is how a rotation destroys the
   only copy of a key. The API refusing writes is **correct fail-closed
   behaviour**, not an outage to route around.
4. **Roll back and retry** with the migration fix applied.
   ```bash
   pnpm exec prisma migrate resolve --rolled-back <migration-name>
   pnpm prisma:migrate:prod
   ```
5. **Re-enable writes** behind the flag, and confirm `/v1/ready`.

**Suspected key-material exposure:** if any key material, JWT, or webhook
secret appears in logs, terminal output, or the after-action notes, stop and
escalate immediately via [`SECURITY.md`](../SECURITY.md). Do not paste the
material into a ticket. Treat it as compromised and rotate.

---

## Verifying the recovery

Verify with the real e2e specs — not with suites that no longer exist:

```bash
# The migration-recovery contract (documentation/CI only)
pnpm test:e2e -- test/migration-recovery-tabletop.e2e-spec.ts

# The /v1 surface is still mounted and healthy
pnpm test:e2e -- test/app.e2e-spec.ts

# Boot the real AppModule exactly as main.ts does
pnpm test:e2e -- test/app-module-bootstrap.e2e-spec.ts
```

Then confirm the running service: `GET /v1/ready` reports `ready`, and
`GET /v1/health` reports `ok`.

## Related documents

- [`docs/migration-recovery-tabletop.md`](./migration-recovery-tabletop.md) — the
  tabletop exercise for this runbook
- [`docs/PRISMA-MIGRATIONS.md`](./PRISMA-MIGRATIONS.md) — migration naming and
  authoring rules
- [`docs/MIGRATION-KEY-MANAGEMENT.md`](./MIGRATION-KEY-MANAGEMENT.md) —
  key-management migration path
- [`docs/FEATURE-FLAGS.md`](./FEATURE-FLAGS.md) — kill-switches used above
- [`SECURITY.md`](../SECURITY.md) — disclosure and escalation
