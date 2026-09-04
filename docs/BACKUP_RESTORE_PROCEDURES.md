# Database Backup and Restore Procedures

This document describes the procedures for backing up and restoring the Mux Backend database. Regular backup and restore drills are essential for disaster recovery planning.

## Overview

The backup system provides:
- **Health Checks**: Verify database connectivity before operations
- **Backup Metadata**: Collect record counts and timestamps for verification
- **Restore Drills**: Non-destructive validation of restore capability
- **Procedure Documentation**: Operational guidelines for backup/restore

## Admin Endpoints

All endpoints require `X-Cron-Secret` header authentication.

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
  "message": "Database connection is healthy"
}
```

### Collect Backup Metadata

**Endpoint:** `POST /backup/metadata`

Collects current database metadata including record counts and timestamps. This should be saved for backup verification.

```bash
curl -X POST -H "X-Cron-Secret: ${CRON_SECRET}" \
  https://api.example.com/backup/metadata
```

**Response:**
```json
{
  "backupId": "backup_1704067200000_abc123def",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "duration": 1234,
  "status": "success",
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
  https://api.example.com/backup/drill
```

**Response:**
```json
{
  "drillId": "drill_1704067200000_xyz789",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "success": true,
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

## Backup Procedures

### Regular Backups (Daily/Weekly)

1. **Verify Database Health**
   ```bash
   curl -H "X-Cron-Secret: ${CRON_SECRET}" \
     https://api.example.com/backup/health
   ```
   - Confirm response shows `"databaseHealthy": true`

2. **Collect Backup Metadata**
   ```bash
   curl -X POST -H "X-Cron-Secret: ${CRON_SECRET}" \
     https://api.example.com/backup/metadata
   ```
   - Save the response (backupId, recordCounts, timestamp)
   - Store in secure location for restore verification

3. **Create Backup Using Managed Service**
   - Use AWS RDS automated backups
   - Or Supabase automated backups
   - Or your managed database provider's backup service
   - Verify backup completion in provider console

4. **Verify Backup Integrity**
   - Confirm backup appears in provider's backup list
   - Check backup size is reasonable
   - Verify backup contains expected tables

5. **Store Backup Metadata**
   - Save recordCounts in backup documentation
   - Link backup ID to Mux backupId
   - Store in disaster recovery runbook

## Restore Procedures

### Restoring from Backup (Disaster Recovery)

**Prerequisites:**
- Have backup ID and location
- Have backup metadata (recordCounts)
- Access to restore target database
- Connection string for restored database

**Steps:**

1. **Verify Restore Target**
   - Ensure target database is clean and empty
   - Confirm network connectivity to target
   - Verify sufficient storage capacity

2. **Restore Database from Backup**
   - Using AWS RDS console:
     - Go to "Snapshots"
     - Select the backup snapshot
     - Click "Restore from Snapshot"
     - Wait for restoration to complete
   - Or using Supabase console:
     - Go to "Database" → "Backups"
     - Select backup
     - Click "Restore"

3. **Verify Record Counts**
   - Connect to restored database
   - Run health check:
     ```bash
     curl -H "X-Cron-Secret: ${CRON_SECRET}" \
       -H "DATABASE_URL=postgresql://restored..." \
       https://api.example.com/backup/health
     ```
   - Collect metadata from restored database
   - Compare recordCounts with backup metadata

4. **Run Restore Drill**
   ```bash
   curl -X POST -H "X-Cron-Secret: ${CRON_SECRET}" \
     -H "DATABASE_URL=postgresql://restored..." \
     https://api.example.com/backup/drill
   ```
   - Confirm all validations pass: `"success": true`

5. **Perform Application Health Checks**
   - Deploy application pointing to restored database
   - Run application health checks
   - Verify wallet operations work
   - Verify transaction queries work
   - Check API key authentication

6. **Validate Critical Data**
   - Spot-check important transactions
   - Verify user accounts are intact
   - Check wallet balances are present
   - Verify API keys still exist

7. **Cut Over to Restored Database** (if needed)
   - Update connection string in production
   - Monitor logs for errors
   - Verify frontend connectivity

## Testing & Maintenance

### Monthly Restore Drills

Schedule monthly restore drills to verify disaster recovery capability:

1. **Set Reminder**
   - Schedule for first Monday of each month
   - Assign to ops/SRE team

2. **Execute Drill on Staging**
   - Use a staging environment database
   - Don't test on production

3. **Run Health Check**
   ```bash
   curl -H "X-Cron-Secret: ${CRON_SECRET}" \
     https://staging-api.example.com/backup/health
   ```

4. **Collect Backup Metadata**
   ```bash
   curl -X POST -H "X-Cron-Secret: ${CRON_SECRET}" \
     https://staging-api.example.com/backup/metadata
   ```

5. **Perform Restore Drill**
   ```bash
   curl -X POST -H "X-Cron-Secret: ${CRON_SECRET}" \
     https://staging-api.example.com/backup/drill
   ```

6. **Document Results**
   - Save drill result JSON
   - Note any issues or warnings
   - Verify all validations passed
   - Update runbook if procedures changed

### Backup Strategy

| Aspect | Recommendation |
|--------|-----------------|
| Frequency | Daily (automated via managed service) |
| Retention | 30 days minimum (check provider settings) |
| Testing | Monthly restore drill on staging |
| Documentation | Keep backup metadata for 90 days |
| Alerts | Setup notifications for failed backups |
| RPO | 24 hours (accept up to 1 day data loss) |
| RTO | 4 hours (restore within 4 hours) |

## Troubleshooting

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

### High Restore Duration

**Issue:** Restore drill takes longer than expected

**Solutions:**
- Check database load (other queries running)
- Check disk I/O performance
- Check network latency if remote database
- Consider adding indexes to frequently-queried tables

## Related Documentation

- [Database Schema](../prisma/schema.prisma)
- [Disaster Recovery Runbook](./DISASTER_RECOVERY.md)
- [Database Maintenance](./DATABASE_MAINTENANCE.md)

## Contact & Escalation

- **On-Call SRE:** [Escalation Path]
- **DBA:** [Contact Information]
- **Incident Commander:** [Contact Information]
