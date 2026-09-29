import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetricsService } from '../common/metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { BackupController } from './backup.controller';
import { BackupEncryptionService } from './backup-encryption.service';
import { BackupService } from './backup.service';
import { BACKUP_STORE } from './backup.store';
import { PrismaBackupStore } from './prisma-backup.store';

/**
 * Backup module: the surface documented in
 * `docs/BACKUP_RESTORE_PROCEDURES.md` (#906, #947).
 *
 * Provides health checks, metadata collection, restore drills, the procedures
 * endpoint, restore-intent validation, and the backup encryption key rotation
 * probe. Every route is guarded by `CronSecretGuard` (deny-by-default), and
 * `BackupEncryptionService` refuses to construct without a valid
 * `BACKUP_ENCRYPTION_KEY`, so the module cannot boot with a weak or missing
 * key.
 */
@Module({
  imports: [ConfigModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    BackupEncryptionService,
    PrismaBackupStore,
    PrismaService,
    MetricsService,
    { provide: BACKUP_STORE, useExisting: PrismaBackupStore },
  ],
  exports: [BackupService, BackupEncryptionService],
})
export class BackupModule {}
