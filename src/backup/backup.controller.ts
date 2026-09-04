import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { BackupService } from './backup.service';
import { CronSecretGuard } from '../common/cron/cron-secret.guard';

/**
 * Admin endpoints for backup and restore operations
 * All endpoints require X-Cron-Secret header for security
 */
@ApiTags('backup-admin')
@Controller('backup')
@UseGuards(CronSecretGuard)
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @ApiOperation({
    summary: 'Health check for database backup operations',
    description:
      'Verifies that the database connection is healthy and ready for backup. ' +
      'This should be called before any backup or restore operation. ' +
      'Requires X-Cron-Secret header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Database health check result',
    schema: {
      example: {
        databaseHealthy: true,
        connectionWorks: true,
        query: 'success',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: 'Database connection is healthy',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid X-Cron-Secret header',
  })
  @Get('health')
  async healthCheck() {
    return this.backupService.healthCheck();
  }

  @ApiOperation({
    summary: 'Collect backup metadata snapshot',
    description:
      'Collects current database metadata including record counts and timestamps. ' +
      'Used for backup documentation and restore verification. ' +
      'This is a read-only operation. ' +
      'Requires X-Cron-Secret header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Backup metadata collected',
    schema: {
      example: {
        backupId: 'backup_1704067200000_abc123def',
        timestamp: '2026-01-01T00:00:00.000Z',
        duration: 1234,
        status: 'success',
        recordCounts: {
          users: 100,
          wallets: 250,
          transactions: 1500,
          apiKeys: 50,
          projects: 10,
          developers: 5,
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid X-Cron-Secret header',
  })
  @Post('metadata')
  async collectMetadata() {
    return this.backupService.collectBackupMetadata();
  }

  @ApiOperation({
    summary: 'Perform database restore drill (validation only)',
    description:
      'Non-destructive operation that validates database can be restored from backup. ' +
      'Checks table existence, record counts, foreign key constraints, and indexes. ' +
      'Does not modify any data. ' +
      'Useful for periodic disaster recovery testing. ' +
      'Requires X-Cron-Secret header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Restore drill completed',
    schema: {
      example: {
        drillId: 'drill_1704067200000_xyz789',
        timestamp: '2026-01-01T00:00:00.000Z',
        success: true,
        validationResults: {
          tablesExist: true,
          recordsCountMatch: true,
          constraintsIntact: true,
          indexesPresent: true,
        },
        recordCounts: {
          users: 100,
          wallets: 250,
          transactions: 1500,
          apiKeys: 50,
          projects: 10,
          developers: 5,
        },
        duration: 2345,
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid X-Cron-Secret header',
  })
  @Post('drill')
  async restoreDrill() {
    return this.backupService.performRestoreDrill();
  }

  @ApiOperation({
    summary: 'Get backup and restore procedures documentation',
    description:
      'Returns operational procedures for backing up and restoring the database. ' +
      'Includes steps for regular backups, restore procedures, and testing guidelines. ' +
      'Requires X-Cron-Secret header.',
  })
  @ApiResponse({
    status: 200,
    description: 'Backup procedures documentation',
    schema: {
      example: {
        backup: [
          '1. Verify database health using health check endpoint',
          '2. Collect backup metadata (record counts and timestamps)',
          '3. Use managed backup service to create backup',
        ],
        restore: [
          '1. Verify restore target database exists',
          '2. Restore database from backup',
        ],
        testing: [
          '1. Schedule monthly restore drills',
          '2. Run health check before restore drill',
        ],
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid X-Cron-Secret header',
  })
  @Get('procedures')
  getProcedures() {
    return this.backupService.getBackupProcedures();
  }
}
