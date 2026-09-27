# Backup & Restore Procedures — Mux Backend

> **Status:** Production runbook  
> **Owner:** Platform / SRE  
> **Last drill:** 2026-09-27  
> **References:** Issue #979

---

## 1. Scope

This document covers:

- PostgreSQL database backups (primary data store via Prisma/PgSQL)
- Encrypted wallet key material (via `WALLET_ENCRYPTION_KEY` + AES-256-GCM)
- Environment secrets (`.env` / hosted secret manager values)
- Restoration procedures and drill evidence checklist

**Out of scope:** Stellar on-chain state (immutable, always recoverable from chain).

---

## 2. Backup Assets

| Asset | Storage | Frequency | Retention |
|---|---|---|---|
| PostgreSQL full dump | Object storage (encrypted) | Daily 02:00 UTC | 30 days |
| PostgreSQL WAL/PITR | Managed DB provider logs | Continuous | 7 days |
| `WALLET_ENCRYPTION_KEY` | Secret manager (never in DB) | On rotation | Previous 2 versions |
| Environment secrets | Secret manager | On change | Previous 3 versions |

---

## 3. Database Backup

### 3.1 Manual Backup

```bash
# Full logical dump (replace placeholders)
pg_dump \
  --format=custom \
  --no-acl \
  --no-owner \
  --verbose \
  "$DATABASE_URL" \
  > "mux_backup_$(date +%Y%m%dT%H%M%SZ).dump"
```

Store the dump in an encrypted bucket. Never commit dump files to version control.

### 3.2 Automated Backup Verification

Automated backups should be verified weekly:

```bash
# List recent backups (adjust for your bucket/provider)
aws s3 ls s3://mux-backups/postgres/ --recursive | tail -10
```

---

## 4. Restore Procedures

### 4.1 Database Restore (Full)

```bash
# 1. Provision a clean database (same PG version)
# 2. Apply migrations first to ensure schema consistency
pnpm prisma:migrate:prod

# 3. Restore data
pg_restore \
  --verbose \
  --clean \
  --no-acl \
  --no-owner \
  --dbname="$DATABASE_URL" \
  mux_backup_<TIMESTAMP>.dump
```

> **Invariant:** Always run migrations *before* restoring data when the backup
> may pre-date the current schema version. If the backup was taken after the
> migration it is safe to skip step 2.

### 4.2 Point-in-Time Recovery (PITR)

For managed providers (Railway, Supabase, RDS, etc.) use the platform's PITR
UI to select a recovery timestamp. Confirm the target timestamp with the
incident timeline before initiating.

### 4.3 Wallet Encryption Key Recovery

The `WALLET_ENCRYPTION_KEY` is **never** stored in the database. If it is
lost, all encrypted wallet secrets become unrecoverable.

1. Retrieve the key from the secret manager (e.g. AWS Secrets Manager, Doppler).
2. Set it in the environment before starting the application.
3. Rotate only via the documented key-rotation flow (see
   `docs/key-management-consolidation.md`) to avoid breaking existing wallets.

---

## 5. Drill Procedure & Evidence Checklist

Run this drill quarterly on a staging environment. Record outcomes below.

### Pre-Drill

- [ ] Identify the target backup timestamp
- [ ] Confirm staging DB is isolated from production
- [ ] Verify `WALLET_ENCRYPTION_KEY` for staging is available in the secret manager
- [ ] Ensure at least one engineer with DB admin access is available

### Drill Steps

1. **Snapshot baseline** — record row counts for key tables:

   ```sql
   SELECT
     (SELECT COUNT(*) FROM "User")        AS users,
     (SELECT COUNT(*) FROM "Wallet")      AS wallets,
     (SELECT COUNT(*) FROM "Transaction") AS transactions;
   ```

2. **Drop and recreate** the staging database (or use a separate restore target).

3. **Run migrations**:

   ```bash
   DATABASE_URL=<staging_url> pnpm prisma:migrate:prod
   ```

4. **Restore the dump**:

   ```bash
   pg_restore --verbose --clean --no-acl --no-owner \
     --dbname="<staging_url>" mux_backup_<TIMESTAMP>.dump
   ```

5. **Start the application** against the restored database.

6. **Smoke-test** key endpoints:

   ```bash
   curl -f http://localhost:3000/v1/health
   curl -f http://localhost:3000/v1/ready
   ```

7. **Verify row counts** match the pre-dump baseline recorded in step 1.

8. **Attempt a wallet decrypt** operation to confirm `WALLET_ENCRYPTION_KEY` is
   correct and encrypted secrets are intact.

### Post-Drill

- [ ] Record actual vs expected row counts (diff acceptable if time elapsed)
- [ ] Record `/health` and `/ready` response status
- [ ] Record whether wallet decryption succeeded
- [ ] Log any deviations and open follow-up issues

### Drill Log

| Date | Operator | Backup Timestamp Used | Result | Notes |
|---|---|---|---|---|
| 2026-09-27 | Platform SRE | Latest daily | ✅ Pass | Initial drill on staging |

---

## 6. Fail-Closed Invariants

- If `WALLET_ENCRYPTION_KEY` is missing at boot the application **fails to start** (validated in `src/app.service.ts`).
- A failed DB restore leaves the application in a non-ready state; `/ready` returns `503` until the DB is reachable.
- Backup files must be encrypted at rest. Never store plaintext dumps in shared storage.
- Drill results must be appended to the table above and reviewed at each quarterly security review.

---

## 7. Rollback Strategy

If a restore introduces regressions:

1. Re-point `DATABASE_URL` to the previous primary (blue/green) if applicable.
2. Re-run `pnpm prisma:migrate:prod` to ensure schema consistency.
3. Re-deploy the previous application image.
4. Alert on-call via the standard incident channel.

---

## 8. Backup Module Invariants

These invariants MUST hold for every backup/restore operation. They are enforced by the backup module and covered by automated tests.

1. **Deny-by-default authz**: Every backup/restore entrypoint requires an authenticated principal (owner, guardian, API key, or JWT). Requests without a valid credential are rejected with `401`; requests with an insufficient role are rejected with `403`. There is no anonymous access path.
2. **Idempotency**: Backup and restore requests carry an idempotency key. Concurrent or replayed requests with the same key return the original result and never re-execute side effects.
3. **Fail-closed writes**: If a dependency (RPC, DB, or Horizon) is unavailable, write operations fail closed with a stable error code. No partial or best-effort writes are performed.
4. **Source of truth**: The server/contract remains the source of truth for spends, recovery, and admin. Backup metadata is advisory and never overrides on-chain state.
5. **No secret leakage**: Logs and metrics redact keys, JWTs, webhook secrets, and raw key material. Only correlation ids and stable error codes are emitted.

### Stable Error Codes

| Code | Meaning |
|------|---------|
| `BACKUP_UNAUTHORIZED` | Missing or invalid credential (401) |
| `BACKUP_FORBIDDEN` | Authenticated but insufficient role (403) |
| `BACKUP_DEPENDENCY_UNAVAILABLE` | RPC/DB/Horizon unavailable; write failed closed (503) |
| `BACKUP_IDEMPOTENCY_CONFLICT` | Same idempotency key reused with a different payload (409) |
| `BACKUP_INVALID_INPUT` | Adversarial or malformed input, e.g. oversized batch (400) |
| `BACKUP_INTERNAL_ERROR` | Unexpected failure (500) |

Every response includes a `correlationId` for tracing. Correlation ids are safe to log; credentials and key material are not.

---

## 9. Backup Admin Endpoints

All endpoints require authentication. In addition to the `X-Cron-Secret` header used by scheduled jobs, callers may authenticate as an owner/guardian via API key or JWT. Requests are denied by default when no valid credential is present.

### Health Check

**Endpoint:** `GET /backup/health`

Verifies that the database connection is healthy and ready for backup operations.

```bash
curl -H "X-Cron-Secret: ${CRON_SECRET}" \
  https://api.example.com/backup/health
```

**Response:**
```json
{
  "databaseHealthy": true,
  "connectionWorks": true,
  "query": "success",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "correlationId": "corr_1704067200000_abc123def",
  "message": "Database connection is healthy"
}
```

### Collect Backup Metadata

**Endpoint:** `POST /backup/metadata`

Collects current database metadata including record counts and timestamps. This should be saved for backup verification. The request is idempotent when an `Idempotency-Key` header is supplied.

```bash
curl -X POST -H "X-Cron-Secret: ${CRON_SECRET}" \
  -H "Idempotency-Key: backup-2026-01-01" \
  https://api.example.com/backup/metadata
```

**Response:**
```json
{
  "backupId": "backup_1704067200000_abc123def",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "duration": 1234,
  "status": "success",
  "correlationId": "corr_1704067200000_abc123def",
  "recordCounts": {
    "users": 100,
    "wallets": 250,
    "transactions": 1500,
    "apiKeys": 50,
    "projects": 10,
    "developers": 5
  }
}
```

### Restore Drill

**Endpoint:** `POST /backup/drill`

Performs a non-destructive validation that the database can be restored from backup. Checks:
- All required tables exist
- Record counts are consistent
- Foreign key constraints are intact
- Indexes are present

```bash
curl -X POST -H "X-Cron-Secret: ${CRON_SECRET}" \
  -H "Idempotency-Key: drill-2026-01-01" \
  https://api.example.com/backup/drill
```

**Response:**
```json
{
  "drillId": "drill_1704067200000_xyz789",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "success": true,
  "correlationId": "corr_1704067200000_xyz789",
  "validationResults": {
    "tablesExist": true,
    "recordsCountMatch": true,
    "constraintsIntact": true,
    "indexesPresent": true
  },
  "recordCounts": {
    "users": 100,
    "wallets": 250,
    "transactions": 1500,
    "apiKeys": 50,
    "projects": 10,
    "developers": 5
  },
  "duration": 2345
}
```

### Backup Procedures

**Endpoint:** `GET /backup/procedures`

Returns operational procedures for backup and restore.

```bash
curl -H "X-Cron-Secret: ${CRON_SECRET}" \
  https://api.example.com/backup/procedures
```

---

## 10. Troubleshooting

### Health Check Fails

**Error:** `"databaseHealthy": false`

**Solutions:**
- Check database is running: `psql -c "SELECT 1"`
- Check network connectivity to database host
- Check security groups / firewall rules
- Check database credentials in environment

### Restore Drill Fails - Constraints

**Error:** `"constraintsIntact": false`

**Causes:**
- Foreign key violations in restored data
- Orphaned records (wallet without user, etc.)

**Solutions:**
- Run constraint checks in database: `SELECT * FROM information_schema.table_constraints`
- Identify orphaned records and delete them
- Re-run restore drill

### Dependency Outage (RPC/DB/Horizon)

**Error:** `BACKUP_DEPENDENCY_UNAVAILABLE`

**Behavior:** Write operations fail closed. The backup module does not attempt partial writes and does not fall back to a stale cache.

**Solutions:**
- Check dependency status pages (RPC, Horizon, managed DB)
- Retry once the dependency recovers; the idempotency key makes retries safe
- Do not disable fail-closed behavior to force a write through

### Idempotency Conflict

**Error:** `BACKUP_IDEMPOTENCY_CONFLICT`

**Cause:** The same `Idempotency-Key` was reused with a different payload.

**Solutions:**
- Use a fresh idempotency key for a genuinely new operation
- Reuse the original key only to retrieve the original result

### High Restore Duration

**Issue:** Restore drill takes longer than expected

**Solutions:**
- Check database load (other queries running)
- Check disk I/O performance
- Check network latency if remote database
- Consider adding indexes to frequently-queried tables

---

## 11. Cross-References

- [Key Management Consolidation](./key-management-consolidation.md)
- [Custody Security Model](./custody-security-model.md)
- [Key Rotation Audit](../src/key-management/key-rotation-audit.service.ts)
- [Migration Guide](./MIGRATION-KEY-MANAGEMENT.md)
- [Database Schema](../prisma/schema.prisma)
- [Disaster Recovery Runbook](./DISASTER_RECOVERY.md)
- [Security Policy](../SECURITY.md)
- [Backup Module E2E Tests](../test/backup-module-registered.e2e-spec.ts)
- `WALLET_ENCRYPTION_KEY` validation: `src/app.service.ts`
