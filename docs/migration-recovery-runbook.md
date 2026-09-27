# Failed Migration Recovery Runbook

## Overview

This runbook provides procedures for detecting, diagnosing, and recovering from failed database migrations in the Mux Backend API.

> **Key management migrations:** For the custody key-management migration path (versioned key envelopes, fail-closed decrypt, authz), see the dedicated [Key Management Migration Runbook](#key-management-migration-runbook) section below and the cross-linked references:
> - [`docs/MIGRATION-KEY-MANAGEMENT.md`](./MIGRATION-KEY-MANAGEMENT.md)
> - [`docs/key-management-consolidation.md`](./key-management-consolidation.md)
> - [`docs/custody-security-model.md`](./custody-security-model.md)

> **Successor migration tooling:** For the wallet successor migration path (`wallet.successor_id`, migration `prisma/migrations/20260601000000_add_wallet_successor_id/`), see the dedicated [Successor Migration Runbook](#successor-migration-runbook) section below.

## Quick Reference

| Scenario | Steps | Recovery Time |
|----------|-------|---------------|
| Migration hangs | Check logs → Kill process → Rollback | 5-10 min |
| Syntax error | Fix schema → Rollback → Retry | 10-15 min |
| Constraint violation | Backfill data → Rollback → Retry | 15-30 min |
| Lock timeout | Kill blocking query → Retry | 5 min |
| Key envelope migration failure | Halt writes → Verify version → Rollback → Retry | 15-30 min |
| Successor migration failure | Halt writes → Verify successor_id → Rollback → Retry | 15-30 min |

---

## Detection

### Signs of Migration Failure

1. **Application startup fails** with migration error
2. **Database logs** show:
   - `ERROR: relation "table_name" already exists`
   - `ERROR: column "column_name" does not exist`
   - `deadlock detected`
   - `statement timeout`
3. **Metrics** show stuck migration:
   - Long-running transaction in `pg_stat_activity`
   - No progress on migration commit

### Check Migration Status

```bash
# List applied migrations
psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 10;"

# Find stuck migrations
psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM _prisma_migrations WHERE finished_at IS NULL;"

# Check long-running transactions
psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM pg_stat_activity WHERE state = 'active' AND xact_start < NOW() - INTERVAL '5 minutes';"
```

---

## Recovery Procedures

### Scenario 1: Syntax Error in Migration

**Symptoms:**
- `ERROR: syntax error at or near...`
- Migration marked as started but not finished

**Steps:**

1. **Stop the application**
   ```bash
   kubectl scale deployment mux-api --replicas=0
   ```

2. **Identify the failed migration**
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT name FROM _prisma_migrations WHERE finished_at IS NULL;"
   ```

3. **Rollback (Prisma handles this)**
   ```bash
   # Prisma automatically rolls back failed migrations
   npm run prisma:migrate:resolve -- --rolled-back <migration-name>
   ```

4. **Fix the migration file**
   - Edit the migration SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`
   - Correct syntax errors

5. **Retry migration**
   ```bash
   npm run prisma:migrate:deploy
   ```

6. **Restart application**
   ```bash
   kubectl scale deployment mux-api --replicas=3
   ```

### Scenario 2: Constraint Violation

**Symptoms:**
- `ERROR: duplicate key value violates unique constraint`
- `ERROR: insert or update on table violates foreign key constraint`

**Steps:**

1. **Analyze constraint violation**
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM table_name WHERE condition;"
   ```

2. **Fix conflicting data** (backfill or cleanup)
   ```sql
   -- Example: Remove duplicates before adding UNIQUE constraint
   DELETE FROM table_name WHERE id NOT IN (
     SELECT MIN(id) FROM table_name GROUP BY unique_col
   );
   ```

3. **Rollback migration**
   ```bash
   npm run prisma:migrate:resolve -- --rolled-back <migration-name>
   ```

4. **Retry after data fix**
   ```bash
   npm run prisma:migrate:deploy
   ```

### Scenario 3: Lock Timeout

**Symptoms:**
- `ERROR: canceling statement due to lock timeout`
- `statement timeout` in logs

**Steps:**

1. **Identify blocking queries**
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT blocked_locks.pid, blocked_locks.relation::regclass, blocking_locks.pid, blocking_locks.relation::regclass FROM pg_locks blocked_locks JOIN pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid AND blocking_locks.granted AND NOT blocked_locks.granted WHERE NOT blocked_locks.granted;"
   ```

2. **Terminate blocking transaction**
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid != pg_backend_pid() AND query LIKE '%your-table-name%' AND state = 'active';"
   ```

3. **Increase lock_timeout** (temporary)
   ```sql
   SET lock_timeout = '30 seconds';
   ```

4. **Retry migration**
   ```bash
   npm run prisma:migrate:deploy
   ```

### Scenario 4: Hung Migration

**Symptoms:**
- Migration started hours ago
- No errors in logs
- Application waiting on migration

**Steps:**

1. **Check migration status**
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM _prisma_migrations WHERE finished_at IS NULL AND started_at < NOW() - INTERVAL '1 hour';"
   ```

2. **Identify long-running transaction**
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT pid, usename, xact_start, state_change, query FROM pg_stat_activity WHERE xact_start < NOW() - INTERVAL '1 hour';"
   ```

3. **Terminate stuck transaction**
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT pg_terminate_backend(<pid>);"
   ```

4. **Mark migration as rolled back**
   ```bash
   npm run prisma:migrate:resolve -- --rolled-back <migration-name>
   ```

5. **Investigate root cause** before retry
   - Check for missing indexes
   - Verify disk space
   - Review lock contention

---

## Key Management Migration Runbook

This section covers the custody **key-management migration** path: versioned key envelopes (`wallet_key_version`), fail-closed decrypt, and authz enforcement. It complements [`docs/MIGRATION-KEY-MANAGEMENT.md`](./MIGRATION-KEY-MANAGEMENT.md) and [`docs/key-management-consolidation.md`](./key-management-consolidation.md).

### Invariants (must hold at all times)

1. **Server is source of truth.** Spends, recovery, and admin actions are authorized server-side; clients cannot bypass policy.
2. **Fail-closed decrypt.** If a key envelope cannot be decrypted or its version is unknown, the operation MUST fail with a stable error code — never fall back to plaintext or an older key.
3. **Version monotonicity.** `wallet_key_version` only increases; downgrades are rejected.
4. **Idempotency.** Replayed migration requests with the same idempotency key return the original result and do not re-encrypt.
5. **No secret leakage.** Logs/metrics never contain raw key material, JWTs, or webhook secrets; only correlation ids and version numbers.
6. **Deny-by-default.** New privileged surfaces require explicit owner/delegate/guardian/API-key/JWT authorization.

### Typed entrypoints & stable error codes

Key-management operations return the shared error envelope (`src/common/dto/error-envelope.dto.ts`) with a stable `code` and a `correlationId`:

| Operation | Entrypoint | Authz | Stable error codes |
|-----------|-----------|-------|--------------------|
| Rotate `keyVersion` | `POST /v1/wallets/:id/key/rotate` | owner / guardian | `KEY_ROTATION_VERSION_CONFLICT`, `KEY_ROTATION_DECRYPT_FAILED`, `KEY_ROTATION_INSUFFICIENT_ROLE` |
| Read key metadata | `GET /v1/wallets/:id/key` | owner / delegate / guardian / API-key | `KEY_ROTATION_WALLET_NOT_FOUND`, `KEY_ROT

---

## Successor Migration Runbook

This section covers the **successor migration tooling** path: setting/updating a wallet's `successor_id` (schema field added by `prisma/migrations/20260601000000_add_wallet_successor_id/`). It complements the key-management path above and shares the same fail-closed, deny-by-default posture.

### Invariants (must hold at all times)

1. **Server is source of truth.** Successor assignment is authorized server-side; clients cannot bypass policy by supplying a role or successor id directly.
2. **Fail-closed on dependency outage.** If the DB, RPC, or Horizon is unavailable, successor writes MUST fail with a stable error code — never partially apply or silently succeed.
3. **Idempotency.** Replayed successor-migration requests with the same idempotency key return the original result and do not re-apply the successor assignment.
4. **No secret leakage.** Logs/metrics never contain raw key material, JWTs, or webhook secrets; only correlation ids and wallet ids.
5. **Deny-by-default.** The successor entrypoint requires explicit owner/delegate/guardian/API-key/JWT authorization; wrong role, expired auth, and revoked delegates are rejected.

### Typed entrypoints & stable error codes

Successor-migration operations return the shared error envelope (`src/common/dto/error-envelope.dto.ts`) with a stable `code` and a `correlationId`:

| Operation | Entrypoint | Authz | Stable error codes |
|-----------|-----------|-------|--------------------|
| Set/update successor | `POST /v1/wallets/:id/successor` | owner / guardian | `SUCCESSOR_INSUFFICIENT_ROLE`, `SUCCESSOR_WALLET_NOT_FOUND`, `SUCCESSOR_INVALID_TARGET`, `SUCCESSOR_VERSION_CONFLICT` |
| Read successor | `GET /v1/wallets/:id/successor` | owner / delegate / guardian / API-key | `SUCCESSOR_WALLET_NOT_FOUND`, `SUCCESSOR_INSUFFICIENT_ROLE` |

### Recovery procedure

1. **Halt writes** to the successor entrypoint (feature flag / kill-switch) before touching data.
2. **Verify current state** — confirm `successor_id` values and that the migration is applied:
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT id, successor_id FROM wallet WHERE successor_id IS NOT NULL LIMIT 20;"
   psql -U $DB_USER -d $DB_NAME -c "SELECT name FROM _prisma_migrations WHERE name LIKE '%add_wallet_successor_id%';"
   ```
3. **Rollback** the migration if it is partially applied:
   ```bash
   npm run prisma:migrate:resolve -- --rolled-back 20260601000000_add_wallet_successor_id
   ```
4. **Retry** once the root cause is fixed, then re-enable the entrypoint:
   ```bash
   npm run prisma:migrate:deploy
   ```
5. **Verify** idempotency by replaying a request with the same idempotency key and confirming the original result is returned.

### Rollback / flag strategy

- The successor entrypoint is gated behind a feature flag; disabling it denies all writes (deny-by-default) without data loss.
- Rollback is safe because `successor_id` is additive; reverting the migration drops only the new column.
- Document the flag state and rollback steps in the PR description before landing any mainnet-affecting change.
