import { Test, TestingModule } from '@nestjs/testing';
import { BackupService } from './backup.service';
import { PrismaService } from '../prisma/prisma.service';

describe('BackupService', () => {
  let service: BackupService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      $queryRaw: jest.fn(),
      user: { count: jest.fn() },
      wallet: { count: jest.fn() },
      transaction: { count: jest.fn() },
      apiKey: { count: jest.fn() },
      project: { count: jest.fn() },
      developer: { count: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<BackupService>(BackupService);
  });

  describe('healthCheck', () => {
    it('should return healthy status when database query succeeds', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await service.healthCheck();

      expect(result.databaseHealthy).toBe(true);
      expect(result.connectionWorks).toBe(true);
      expect(result.query).toBe('success');
      expect(result.message).toContain('healthy');
    });

    it('should return unhealthy status when database query fails', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(
        new Error('Connection refused'),
      );

      const result = await service.healthCheck();

      expect(result.databaseHealthy).toBe(false);
      expect(result.connectionWorks).toBe(false);
      expect(result.query).toBe('failed');
      expect(result.message).toContain('failed');
    });
  });

  describe('collectBackupMetadata', () => {
    it('should collect all table record counts', async () => {
      mockPrisma.user.count.mockResolvedValue(100);
      mockPrisma.wallet.count.mockResolvedValue(250);
      mockPrisma.transaction.count.mockResolvedValue(1500);
      mockPrisma.apiKey.count.mockResolvedValue(50);
      mockPrisma.project.count.mockResolvedValue(10);
      mockPrisma.developer.count.mockResolvedValue(5);

      const result = await service.collectBackupMetadata();

      expect(result.status).toBe('success');
      expect(result.recordCounts.users).toBe(100);
      expect(result.recordCounts.wallets).toBe(250);
      expect(result.recordCounts.transactions).toBe(1500);
      expect(result.recordCounts.apiKeys).toBe(50);
      expect(result.recordCounts.projects).toBe(10);
      expect(result.recordCounts.developers).toBe(5);
      expect(result.backupId).toBeTruthy();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return failed status on error', async () => {
      mockPrisma.user.count.mockRejectedValue(
        new Error('Query failed'),
      );

      const result = await service.collectBackupMetadata();

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Query failed');
    });

    it('should include timestamp and backupId', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.wallet.count.mockResolvedValue(0);
      mockPrisma.transaction.count.mockResolvedValue(0);
      mockPrisma.apiKey.count.mockResolvedValue(0);
      mockPrisma.project.count.mockResolvedValue(0);
      mockPrisma.developer.count.mockResolvedValue(0);

      const result = await service.collectBackupMetadata();

      expect(result.backupId).toMatch(/^backup_/);
      expect(result.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('performRestoreDrill', () => {
    beforeEach(() => {
      // Mock all count operations for restore drill
      mockPrisma.user.count.mockResolvedValue(100);
      mockPrisma.wallet.count.mockResolvedValue(250);
      mockPrisma.transaction.count.mockResolvedValue(1500);
      mockPrisma.apiKey.count.mockResolvedValue(50);
      mockPrisma.project.count.mockResolvedValue(10);
      mockPrisma.developer.count.mockResolvedValue(5);
    });

    it('should complete restore drill successfully with all validations passing', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.performRestoreDrill();

      expect(result.success).toBe(true);
      expect(result.validationResults.tablesExist).toBe(true);
      expect(result.validationResults.recordsCountMatch).toBe(true);
      expect(result.drillId).toMatch(/^drill_/);
      expect(result.recordCounts.users).toBe(100);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should mark validations as failed on constraint check failure', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([]) // Health check passes
        .mockRejectedValueOnce(new Error('Foreign key violation'));

      const result = await service.performRestoreDrill();

      expect(result.validationResults.constraintsIntact).toBe(false);
    });

    it('should include record counts in validation results', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.performRestoreDrill();

      expect(result.recordCounts).toEqual({
        users: 100,
        wallets: 250,
        transactions: 1500,
        apiKeys: 50,
        projects: 10,
        developers: 5,
      });
    });

    it('should handle errors gracefully during restore drill', async () => {
      mockPrisma.user.count.mockRejectedValue(new Error('Database error'));

      const result = await service.performRestoreDrill();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  describe('getBackupProcedures', () => {
    it('should return backup procedures', () => {
      const procedures = service.getBackupProcedures();

      expect(procedures).toHaveProperty('backup');
      expect(procedures).toHaveProperty('restore');
      expect(procedures).toHaveProperty('testing');
      expect(Array.isArray(procedures.backup)).toBe(true);
      expect(Array.isArray(procedures.restore)).toBe(true);
      expect(Array.isArray(procedures.testing)).toBe(true);
    });

    it('should include detailed procedural steps', () => {
      const procedures = service.getBackupProcedures();

      expect(procedures.backup.length).toBeGreaterThan(0);
      expect(procedures.restore.length).toBeGreaterThan(0);
      expect(procedures.testing.length).toBeGreaterThan(0);

      // Check that steps contain instructional content
      expect(procedures.backup.some((step) => step.includes('health'))).toBe(
        true,
      );
      expect(procedures.restore.some((step) => step.includes('restore'))).toBe(
        true,
      );
      expect(procedures.testing.some((step) => step.includes('drill'))).toBe(
        true,
      );
    });
  });
});
