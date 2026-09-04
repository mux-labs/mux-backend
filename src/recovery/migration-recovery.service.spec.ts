import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MigrationRecoveryService } from './migration-recovery.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MigrationRecoveryService', () => {
  let service: MigrationRecoveryService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MigrationRecoveryService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<MigrationRecoveryService>(MigrationRecoveryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('recordMigrationFailure', () => {
    it('should record a migration failure', () => {
      const migrationName = '20260723_add_asset_code_to_payment';
      const error = new Error('Column already exists');

      const record = service.recordMigrationFailure(migrationName, error);

      expect(record).toBeDefined();
      expect(record.name).toBe(migrationName);
      expect(record.error).toBe('Column already exists');
      expect(record.status).toBe('FAILED');
      expect(record.failedAt).toBeInstanceOf(Date);
    });

    it('should store failure record for retrieval', () => {
      const migrationName = 'test_migration';
      const error = new Error('Test error');

      service.recordMigrationFailure(migrationName, error);
      const retrieved = service.getFailedMigration(migrationName);

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe(migrationName);
    });
  });

  describe('recordMigrationRollback', () => {
    it('should mark failed migration as rolled back', () => {
      const migrationName = 'test_migration';
      const error = new Error('Test error');

      service.recordMigrationFailure(migrationName, error);
      const rollbackRecord = service.recordMigrationRollback(migrationName);

      expect(rollbackRecord.status).toBe('ROLLED_BACK');
      expect(rollbackRecord.rolledBackAt).toBeInstanceOf(Date);
    });

    it('should throw error when migration not found', () => {
      expect(() => {
        service.recordMigrationRollback('nonexistent_migration');
      }).toThrow(BadRequestException);
    });
  });

  describe('recordMigrationRecovery', () => {
    it('should mark failed migration as recovered', () => {
      const migrationName = 'test_migration';
      const error = new Error('Test error');

      service.recordMigrationFailure(migrationName, error);
      const recoveryRecord = service.recordMigrationRecovery(migrationName);

      expect(recoveryRecord.status).toBe('RECOVERED');
      expect(recoveryRecord.appliedAt).toBeInstanceOf(Date);
    });

    it('should throw error when migration not found', () => {
      expect(() => {
        service.recordMigrationRecovery('nonexistent_migration');
      }).toThrow(BadRequestException);
    });
  });

  describe('getFailedMigrations', () => {
    it('should return all failed migrations', () => {
      const error = new Error('Test error');
      service.recordMigrationFailure('migration_1', error);
      service.recordMigrationFailure('migration_2', error);

      const migrations = service.getFailedMigrations();

      expect(migrations).toHaveLength(2);
      expect(migrations.map((m) => m.name)).toContain('migration_1');
      expect(migrations.map((m) => m.name)).toContain('migration_2');
    });

    it('should return empty array when no failures', () => {
      const migrations = service.getFailedMigrations();
      expect(migrations).toEqual([]);
    });
  });

  describe('clearMigrationHistory', () => {
    it('should clear history for specific migration', () => {
      const error = new Error('Test error');
      service.recordMigrationFailure('migration_1', error);
      service.recordMigrationFailure('migration_2', error);

      service.clearMigrationHistory('migration_1');

      expect(service.getFailedMigration('migration_1')).toBeUndefined();
      expect(service.getFailedMigration('migration_2')).toBeDefined();
    });
  });

  describe('clearAllHistory', () => {
    it('should clear all migration history', () => {
      const error = new Error('Test error');
      service.recordMigrationFailure('migration_1', error);
      service.recordMigrationFailure('migration_2', error);

      service.clearAllHistory();

      expect(service.getFailedMigrations()).toEqual([]);
    });
  });

  describe('migration recovery workflow', () => {
    it('should support failure -> rollback workflow', () => {
      const migrationName = '20260723_migration';
      const error = new Error('Migration failed');

      const failureRecord = service.recordMigrationFailure(migrationName, error);
      expect(failureRecord.status).toBe('FAILED');

      const rollbackRecord = service.recordMigrationRollback(migrationName);
      expect(rollbackRecord.status).toBe('ROLLED_BACK');

      const retrieved = service.getFailedMigration(migrationName);
      expect(retrieved?.status).toBe('ROLLED_BACK');
    });

    it('should support failure -> recovery workflow', () => {
      const migrationName = '20260723_migration';
      const error = new Error('Temporary failure');

      const failureRecord = service.recordMigrationFailure(migrationName, error);
      expect(failureRecord.status).toBe('FAILED');

      const recoveryRecord = service.recordMigrationRecovery(migrationName);
      expect(recoveryRecord.status).toBe('RECOVERED');

      const retrieved = service.getFailedMigration(migrationName);
      expect(retrieved?.appliedAt).toBeDefined();
    });
  });
});
