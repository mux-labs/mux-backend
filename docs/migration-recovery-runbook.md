# Failed Migration Recovery Runbook

## Overview

This runbook provides procedures for detecting, diagnosing, and recovering from failed database migrations in the Mux Backend API.

> **Key management migrations:** For the custody key-management migration path (versioned key envelopes, fail-closed decrypt, authz), see the dedicated [Key Management Migration Runbook](#key-management-migration-runbook) section below and the cross-linked references:
> - [`docs/MIGRATION-KEY-MANAGEMENT.md`](./MIGRATION-KEY-MANAGEMENT.md)
> - [`docs/key-management-consolidation.md`](./key-management-consolidation.md)
> - [`docs/custody-security-model.md`](./custody-security-model.md)

## Quick Reference

| Scenario | Steps | Recovery Time |
|----------|-------|---------------|
| Migration hangs | Check logs → Kill process → Rollback | 5-10 min |
| Syntax error | Fix schema → Rollback → Retry | 10-15 min |
| Constraint violation | Backfill data → Rollback → Retry | 15-30 min |
| Lock timeout | Kill blocking query → Retry | 5 min |
| Key envelope migration failure | Halt writes → Verify version → Rollback → Retry | 15-30 min |

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
| Read key metadata | `GET /v1/wallets/:id/key` | owner / delegate / guardian / API-key | `KEY_ROTATION_WALLET_NOT_FOUND`, `KEY_ROTATION_NOT_AUTHORIZED` |
| List supported versions | `GET /v1/wallets/key/versions` | API-key | — |

Rotation error codes are namespaced `KEY_ROTATION_*` and defined in
`src/wallets/key-rotation.model.ts`. The full set:

| Code | Status | Meaning |
|------|--------|---------|
| `KEY_ROTATION_INVALID_INPUT` | 400 | Malformed wallet id, or a `targetKeyVersion` outside `SUPPORTED_KEY_VERSIONS`. |
| `KEY_ROTATION_WALLET_NOT_FOUND` | 404 | No wallet with that id. |
| `KEY_ROTATION_NOT_AUTHORIZED` | 403 | Caller claimed `owner` for a wallet they do not own. |
| `KEY_ROTATION_INSUFFICIENT_ROLE` | 403 | Role (e.g. `delegate`) may not rotate. |
| `KEY_ROTATION_VERSION_CONFLICT` | 409 | Rotation would not increase `keyVersion` (no-op or downgrade). |
| `KEY_ROTATION_IDEMPOTENCY_CONFLICT` | 409 | Idempotency key reused for a different target version. |
| `KEY_ROTATION_DECRYPT_FAILED` | 503 | Envelope could not be decrypted; **rotation refused, no write applied**. |
| `KEY_ROTATION_VERSION_UNSUPPORTED` | 503 | The wallet's stored version is outside the supported set. |
| `KEY_ROTATION_FEATURE_FLAG_DISABLED` | 503 | `KEY_ROTATION_ENABLED` is not `true`. |
| `KEY_ROTATION_DEPENDENCY_UNAVAILABLE` | 503 | Key store unreachable; **rotation refused, no write applied**. |

All responses include a `correlationId` for tracing; errors are actionable and never echo key material.

### Authz enforcement

- **Owner / delegate / guardian** roles are checked server-side before any key mutation.
- **API-key / JWT** callers are scoped; revoked delegates are rejected (`AUTHZ_DENIED`).
- Expired tokens fail closed; no privileged surface is reachable without an explicit allow.

### Recovery procedure: failed key-envelope migration

**Symptoms:**
- `KEY_DECRYPT_FAILED` or `KEY_VERSION_UNKNOWN` in logs
- Writes to the money path failing closed

**Steps:**

1. **Halt writes** to the affected money path (enable the key-migration kill-switch / feature flag).
   ```bash
   kubectl set env deployment/mux-api KEY_MIGRATION_ENABLED=false
   ```

2. **Verify envelope versions** (no raw key material is read or logged):
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT id, wallet_key_version FROM wallets WHERE wallet_key_version IS NULL OR wallet_key_version < 1;"
   ```

3. **Roll back the failed migration** (see Scenario 1) and confirm `_prisma_migrations` shows it as rolled back.

4. **Re-run the migration** behind the flag, then re-enable writes:
   ```bash
   npm run prisma:migrate:deploy
   kubectl set env deployment/mux-api KEY_MIGRATION_ENABLED=true
   ```

5. **Verify** with the integrity checks below and confirm no `KEY_*` errors in logs.

### Rotation invariants (enforced in code)

`KeyRotationService` (`src/wallets/key-rotation.service.ts`) enforces these
mechanically, each covered by a unit test:

1. **Fail-closed decrypt.** A provider that cannot decrypt the envelope aborts
   the rotation with `KEY_ROTATION_DECRYPT_FAILED` and **no write is applied**.
   There is no fallback to plaintext, to an older key, or to a prior version.
2. **Closed version set.** A wallet whose stored `keyVersion` is not in
   `SUPPORTED_KEY_VERSIONS` is refused with
   `KEY_ROTATION_VERSION_UNSUPPORTED`. An unknown version is never treated as
   "the latest" — that is how a rotation destroys the only copy of a key.
3. **Monotonicity.** `keyVersion` only increases. A no-op or downgrade returns
   `KEY_ROTATION_VERSION_CONFLICT`, so a replayed or out-of-order request cannot
   walk a wallet backwards through derivation schemes.
4. **Idempotent replay.** A repeated request with the same `Idempotency-Key` and
   target returns the original result with `applied: false` and does **not**
   re-encrypt. Reusing the key for a *different* target is
   `KEY_ROTATION_IDEMPOTENCY_CONFLICT` rather than a silent re-run.
5. **Ownership is server-resolved.** The `owner` role is checked against the
   stored `userId`, never against a client-supplied claim. A `delegate` may read
   metadata but can never rotate key material.
6. **No key material anywhere.** Logs, metrics and responses carry version
   numbers, wallet ids and correlation ids only. The envelope is passed through
   opaquely and never inspected, logged, or returned.

### Crypto provider binding

`KeyEnvelopeProvider` is intentionally **not** registered in `WalletsModule`.
Re-encryption belongs to the custody/HSM layer (`src/key-management`), which
owns `WALLET_ENCRYPTION_KEY` and the derivation scheme. Until a deployment binds
the token, `KeyRotationService` fails to construct and the surface is
unreachable — fail-closed by absence rather than fail-open with a stub that
silently "succeeds" and loses a wallet's key. Do not add a default provider
here.

### Rollback / kill-switch

- Rotation is gated by `KEY_ROTATION_ENABLED`; setting it to `false` and
  redeploying returns the service to metadata-read-only. No data migration is
  required: the `keyVersion` column and its `>= 1` check already exist.
- Rollback is safe because envelopes are additive: old versions remain readable
  until explicitly retired.
- To roll a single wallet back after a bad rotation, do **not** attempt a
  version downgrade — it is refused by design. Follow the recovery procedure
  above and re-issue key material through the custody layer instead.

---

## Verification

### After Any Recovery Attempt

1. **Verify database consistency**
   ```bash
   npm run prisma:generate
   npm run prisma:migrate:status
   ```

2. **Run integrity checks**
   ```bash
   npm run db:integrity-check
   ```

3. **Test critical flows**
   ```bash
   npm run test:integration -- --suite=payments
   npm run test:integration -- --suite=wallets
   npm run test:integration -- --suite=recovery
   ```

4. **Monitor application health**
   ```bash
   kubectl logs -f deployment/mux-api -c mux-api | grep -E "ERROR|WARN|migration|KEY_"
   ```

---

## Prevention

### Best Practices

1. **Test migrations locally first**
   ```bash
   docker-compose up -d postgres
   npm run prisma:migrate:dev
   ```

2. **Write idempotent migrations**
   - Use `IF NOT EXISTS` / `IF EXISTS`
   - Handle both old and new schema during transition

3. **Add data backfill migrations separately**
   - Split schema changes and data changes
   - Allows rollback at schema layer

4. **Monitor lock timeouts**
   - Set `statement_timeout = 30s` for large ALTER TABLE
   - Use `ALTER TABLE ... CONCURRENTLY` for indexes on large tables

5. **Use feature flags for compatibility**
   - Support both old and new column names during migration
   - Clean up old code after deployment

### Example: Safe Schema Evolution

```sql
-- Migration 1: Add new column
ALTER TABLE payments ADD COLUMN assetCode TEXT;

-- Migration 2: Populate data (separate, can be retried safely)
UPDATE payments SET assetCode = currency WHERE assetCode IS NULL;

-- Migration 3: Add constraints
ALTER TABLE payments ALTER COLUMN assetCode SET NOT NULL;

-- Migration 4: Deprecate old column (after code updated)
-- ALTER TABLE payments DROP COLUMN currency_old;
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `relation already exists` | Migration already applied | Check `_prisma_migrations` table, mark as rolled-back |
| `column does not exist` | Schema mismatch | Regenerate Prisma client: `npm run prisma:generate` |
| `deadlock detected` | Concurrent migrations | Ensure migrations run serially, check app replicas |
| `statement timeout` | Large table operation | Increase timeout or break into smaller batches |
| `disk space low` | Insufficient storage | Add disk space or clean old transaction logs |
| `KEY_DECRYPT_FAILED` | Envelope unreadable / wrong key | Halt writes, verify `wallet_key_version`, roll back, retry |
| `KEY_VERSION_CONFLICT` | Concurrent rotation | Retry with idempotency key; ensure serial rotation |
| `AUTHZ_DENIED` | Wrong role / revoked delegate | Verify owner/delegate/guardian or API-key/JWT scope |

---

## Escalation

**Immediate:**
- Migration stuck > 30 minutes
- Multiple `KEY_*` errors on the money path
- Suspected key-material exposure (rotate immediately, follow [`docs/custody-security-model.md`](./custody-security-model.md))

**Contacts:**
- On-call engineer (PagerDuty)
- Database team
- Security team (for key-material incidents)
