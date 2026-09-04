# Failed Migration Recovery Runbook

## Overview

This runbook provides procedures for detecting, diagnosing, and recovering from failed database migrations in the Mux Backend API.

## Quick Reference

| Scenario | Steps | Recovery Time |
|----------|-------|---------------|
| Migration hangs | Check logs → Kill process → Rollback | 5-10 min |
| Syntax error | Fix schema → Rollback → Retry | 10-15 min |
| Constraint violation | Backfill data → Rollback → Retry | 15-30 min |
| Lock timeout | Kill blocking query → Retry | 5 min |

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
   kubectl logs -f deployment/mux-api -c mux-api | grep -E "ERROR|WARN|migration"
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

---

## Escalation

**Immediate:**
- Migration stuck > 30 minutes
- Multiple rollback failures
- Production data corruption suspected

**Contact:**
- On-call DBA: `@dba-oncall` (Slack)
- Database team: `database-team@mux-labs.com`
- CTO: For critical data loss scenarios

---

## Audit & Compliance

All failed migrations are tracked via `MigrationRecoveryService`:
- Logged to application logs
- Recovery actions recorded in service state
- Use for post-incident analysis

**Retention:** 30 days in recovery service memory (logs permanent in ELK)

---

## Related Documentation

- [Prisma Migrations Guide](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate)
- [PostgreSQL Transaction Handling](https://www.postgresql.org/docs/current/runtime-config-client.html)
- [Mux Backend Architecture](../docs/architecture.md)
