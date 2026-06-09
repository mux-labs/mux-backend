import { Test, TestingModule } from '@nestjs/testing';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { PrismaService } from '../prisma/prisma.service';

enum KeyOperation {
  GENERATE = 'GENERATE',
  SIGN = 'SIGN',
  ROTATE = 'ROTATE',
  REVOKE = 'REVOKE',
  ACCESS = 'ACCESS',
}

describe('KeyRotationAuditService', () => {
  let service: KeyRotationAuditService;
  let prisma: PrismaService;

  const mockPrismaService = {
    keyRotationAuditLog: {
      create: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyRotationAuditService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<KeyRotationAuditService>(KeyRotationAuditService);
    prisma = module.get<PrismaService>(PrismaService);

    // Reset mocks
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('persistAuditLog', () => {
    it('should persist a single audit log with all fields', async () => {
      const timestamp = new Date('2024-01-01T12:00:00Z');
      const request = {
        operation: KeyOperation.GENERATE,
        keyId: 'key-123',
        publicKey: 'GPUBLIC123...',
        timestamp,
        success: true,
        errorMessage: undefined,
        metadata: { keyType: 'STELLAR_ED25519' },
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        keyType: 'STELLAR_ED25519',
        retentionDays: 365,
      };

      mockPrismaService.keyRotationAuditLog.create.mockResolvedValue({
        id: 'audit-1',
        ...request,
        expiresAt: new Date(timestamp.getTime() + 365 * 24 * 60 * 60 * 1000),
      });

      await service.persistAuditLog(request);

      expect(prisma.keyRotationAuditLog.create).toHaveBeenCalledWith({
        data: {
          operation: KeyOperation.GENERATE,
          keyId: 'key-123',
          publicKey: 'GPUBLIC123...',
          timestamp,
          success: true,
          errorMessage: undefined,
          metadata: { keyType: 'STELLAR_ED25519' },
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
          keyType: 'STELLAR_ED25519',
          previousKeyId: undefined,
          newKeyId: undefined,
          expiresAt: new Date(timestamp.getTime() + 365 * 24 * 60 * 60 * 1000),
        },
      });
    });

    it('should persist audit log without expiration when retention days not specified', async () => {
      const request = {
        operation: KeyOperation.SIGN,
        keyId: 'key-456',
        publicKey: 'GPUBLIC456...',
        timestamp: new Date(),
        success: true,
      };

      mockPrismaService.keyRotationAuditLog.create.mockResolvedValue({
        id: 'audit-2',
        ...request,
      });

      await service.persistAuditLog(request);

      expect(prisma.keyRotationAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operation: KeyOperation.SIGN,
          keyId: 'key-456',
          expiresAt: undefined,
        }),
      });
    });

    it('should persist failed operation with error message', async () => {
      const request = {
        operation: KeyOperation.ROTATE,
        keyId: 'key-789',
        publicKey: 'GPUBLIC789...',
        timestamp: new Date(),
        success: false,
        errorMessage: 'Invalid key material',
      };

      mockPrismaService.keyRotationAuditLog.create.mockResolvedValue({
        id: 'audit-3',
        ...request,
      });

      await service.persistAuditLog(request);

      expect(prisma.keyRotationAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          errorMessage: 'Invalid key material',
        }),
      });
    });

    it('should persist rotation audit with previous and new key IDs', async () => {
      const request = {
        operation: KeyOperation.ROTATE,
        keyId: 'key-old',
        publicKey: 'GPUBLICNEW...',
        timestamp: new Date(),
        success: true,
        previousKeyId: 'key-old',
        newKeyId: 'key-new',
        keyType: 'STELLAR_ED25519',
      };

      mockPrismaService.keyRotationAuditLog.create.mockResolvedValue({
        id: 'audit-4',
        ...request,
      });

      await service.persistAuditLog(request);

      expect(prisma.keyRotationAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operation: KeyOperation.ROTATE,
          previousKeyId: 'key-old',
          newKeyId: 'key-new',
        }),
      });
    });

    it('should not throw error if persistence fails', async () => {
      const request = {
        operation: KeyOperation.GENERATE,
        keyId: 'key-fail',
        publicKey: 'GPUBLICFAIL...',
        timestamp: new Date(),
        success: true,
      };

      mockPrismaService.keyRotationAuditLog.create.mockRejectedValue(
        new Error('Database error'),
      );

      // Should not throw - errors are logged but not propagated
      await expect(service.persistAuditLog(request)).resolves.not.toThrow();
    });
  });

  describe('persistAuditLogBatch', () => {
    it('should persist multiple audit logs in batch', async () => {
      const timestamp = new Date();
      const requests = [
        {
          operation: KeyOperation.GENERATE,
          keyId: 'key-1',
          publicKey: 'GPUBLIC1...',
          timestamp,
          success: true,
        },
        {
          operation: KeyOperation.SIGN,
          keyId: 'key-2',
          publicKey: 'GPUBLIC2...',
          timestamp,
          success: true,
        },
      ];

      mockPrismaService.keyRotationAuditLog.createMany.mockResolvedValue({
        count: 2,
      });

      await service.persistAuditLogBatch(requests);

      expect(prisma.keyRotationAuditLog.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ keyId: 'key-1' }),
          expect.objectContaining({ keyId: 'key-2' }),
        ]),
        skipDuplicates: true,
      });
    });

    it('should handle empty batch', async () => {
      mockPrismaService.keyRotationAuditLog.createMany.mockResolvedValue({
        count: 0,
      });

      await service.persistAuditLogBatch([]);

      expect(prisma.keyRotationAuditLog.createMany).toHaveBeenCalledWith({
        data: [],
        skipDuplicates: true,
      });
    });

    it('should not throw error if batch persistence fails', async () => {
      const requests = [
        {
          operation: KeyOperation.GENERATE,
          keyId: 'key-1',
          publicKey: 'GPUBLIC1...',
          timestamp: new Date(),
          success: true,
        },
      ];

      mockPrismaService.keyRotationAuditLog.createMany.mockRejectedValue(
        new Error('Database error'),
      );

      await expect(
        service.persistAuditLogBatch(requests),
      ).resolves.not.toThrow();
    });
  });

  describe('queryAuditLogs', () => {
    const mockLogs = [
      {
        id: 'audit-1',
        operation: KeyOperation.GENERATE,
        keyId: 'key-1',
        publicKey: 'GPUBLIC1...',
        timestamp: new Date('2024-01-01'),
        success: true,
        errorMessage: null,
        metadata: null,
        ipAddress: null,
        userAgent: null,
        keyType: 'STELLAR_ED25519',
        previousKeyId: null,
        newKeyId: null,
        expiresAt: null,
      },
      {
        id: 'audit-2',
        operation: KeyOperation.SIGN,
        keyId: 'key-2',
        publicKey: 'GPUBLIC2...',
        timestamp: new Date('2024-01-02'),
        success: true,
        errorMessage: null,
        metadata: null,
        ipAddress: null,
        userAgent: null,
        keyType: 'STELLAR_ED25519',
        previousKeyId: null,
        newKeyId: null,
        expiresAt: null,
      },
    ];

    it('should query audit logs with default pagination', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue(
        mockLogs,
      );
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(2);

      const result = await service.queryAuditLogs({});

      expect(result).toEqual({
        logs: mockLogs,
        total: 2,
        limit: 100,
        offset: 0,
        hasMore: false,
      });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should filter by operation', async () => {
      const filteredLogs = [mockLogs[0]];
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue(
        filteredLogs,
      );
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(1);

      const result = await service.queryAuditLogs({
        operation: KeyOperation.GENERATE,
      });

      expect(result.logs).toEqual(filteredLogs);
      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: { operation: KeyOperation.GENERATE },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should filter by keyId', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue([
        mockLogs[0],
      ]);
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(1);

      await service.queryAuditLogs({ keyId: 'key-1' });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: { keyId: 'key-1' },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should filter by publicKey', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue([
        mockLogs[0],
      ]);
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(1);

      await service.queryAuditLogs({ publicKey: 'GPUBLIC1...' });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: { publicKey: 'GPUBLIC1...' },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should filter by success status', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue(
        mockLogs,
      );
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(2);

      await service.queryAuditLogs({ success: true });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: { success: true },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should filter by date range', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-12-31');

      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue(
        mockLogs,
      );
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(2);

      await service.queryAuditLogs({ startDate, endDate });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: {
          timestamp: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { timestamp: 'desc' },
        take: 100,
        skip: 0,
      });
    });

    it('should support custom pagination', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue([
        mockLogs[1],
      ]);
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(10);

      const result = await service.queryAuditLogs({
        limit: 1,
        offset: 1,
      });

      expect(result).toEqual({
        logs: [mockLogs[1]],
        total: 10,
        limit: 1,
        offset: 1,
        hasMore: true,
      });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { timestamp: 'desc' },
        take: 1,
        skip: 1,
      });
    });

    it('should combine multiple filters', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-12-31');

      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue([
        mockLogs[0],
      ]);
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(1);

      await service.queryAuditLogs({
        operation: KeyOperation.GENERATE,
        keyId: 'key-1',
        success: true,
        startDate,
        endDate,
        limit: 50,
        offset: 10,
      });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: {
          operation: KeyOperation.GENERATE,
          keyId: 'key-1',
          success: true,
          timestamp: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { timestamp: 'desc' },
        take: 50,
        skip: 10,
      });
    });

    it('should indicate hasMore when there are more results', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue(
        mockLogs,
      );
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(100);

      const result = await service.queryAuditLogs({
        limit: 2,
        offset: 0,
      });

      expect(result.hasMore).toBe(true);
    });

    it('should indicate no more results when at end', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue(
        mockLogs,
      );
      mockPrismaService.keyRotationAuditLog.count.mockResolvedValue(2);

      const result = await service.queryAuditLogs({
        limit: 100,
        offset: 0,
      });

      expect(result.hasMore).toBe(false);
    });
  });

  describe('getRotationHistory', () => {
    it('should get rotation history for a key', async () => {
      const keyId = 'key-123';
      const mockHistory = [
        {
          id: 'audit-1',
          operation: KeyOperation.ROTATE,
          keyId,
          publicKey: 'GPUBLICNEW...',
          timestamp: new Date('2024-01-02'),
          success: true,
          errorMessage: null,
          metadata: null,
          ipAddress: null,
          userAgent: null,
          keyType: 'STELLAR_ED25519',
          previousKeyId: keyId,
          newKeyId: 'key-456',
          expiresAt: null,
        },
        {
          id: 'audit-2',
          operation: KeyOperation.GENERATE,
          keyId,
          publicKey: 'GPUBLIC123...',
          timestamp: new Date('2024-01-01'),
          success: true,
          errorMessage: null,
          metadata: null,
          ipAddress: null,
          userAgent: null,
          keyType: 'STELLAR_ED25519',
          previousKeyId: null,
          newKeyId: null,
          expiresAt: null,
        },
      ];

      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue(
        mockHistory,
      );

      const result = await service.getRotationHistory(keyId);

      expect(result).toEqual({
        keyId,
        rotationHistory: mockHistory,
        totalRotations: 1,
      });

      expect(prisma.keyRotationAuditLog.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { keyId },
            { previousKeyId: keyId },
            { newKeyId: keyId },
          ],
        },
        orderBy: { timestamp: 'desc' },
      });
    });

    it('should return empty history for unknown key', async () => {
      mockPrismaService.keyRotationAuditLog.findMany.mockResolvedValue([]);

      const result = await service.getRotationHistory('unknown-key');

      expect(result).toEqual({
        keyId: 'unknown-key',
        rotationHistory: [],
        totalRotations: 0,
      });
    });
  });

  describe('getAuditStatistics', () => {
    it('should calculate audit statistics', async () => {
      mockPrismaService.keyRotationAuditLog.count
        .mockResolvedValueOnce(100) // totalLogs
        .mockResolvedValueOnce(95) // successfulLogs
        .mockResolvedValueOnce(5) // failedLogs
        .mockResolvedValueOnce(10) // rotationLogs
        .mockResolvedValueOnce(50) // generateLogs
        .mockResolvedValueOnce(40); // signLogs

      const result = await service.getAuditStatistics();

      expect(result).toEqual({
        totalLogs: 100,
        successfulLogs: 95,
        failedLogs: 5,
        successRate: 95,
        operationBreakdown: {
          rotate: 10,
          generate: 50,
          sign: 40,
        },
        periodStart: undefined,
        periodEnd: undefined,
      });
    });

    it('should calculate statistics for date range', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-12-31');

      mockPrismaService.keyRotationAuditLog.count
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(48)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(25)
        .mockResolvedValueOnce(20);

      const result = await service.getAuditStatistics(startDate, endDate);

      expect(result.periodStart).toBe(startDate);
      expect(result.periodEnd).toBe(endDate);
      expect(prisma.keyRotationAuditLog.count).toHaveBeenCalledWith({
        where: {
          timestamp: {
            gte: startDate,
            lte: endDate,
          },
        },
      });
    });

    it('should handle zero logs gracefully', async () => {
      mockPrismaService.keyRotationAuditLog.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getAuditStatistics();

      expect(result.totalLogs).toBe(0);
      expect(result.successRate).toBe(100); // Default when no logs
    });
  });

  describe('archiveExpiredLogs', () => {
    it('should delete expired audit logs', async () => {
      mockPrismaService.keyRotationAuditLog.deleteMany.mockResolvedValue({
        count: 42,
      });

      const result = await service.archiveExpiredLogs();

      expect(result).toBe(42);
      expect(prisma.keyRotationAuditLog.deleteMany).toHaveBeenCalledWith({
        where: {
          expiresAt: {
            lte: expect.any(Date),
          },
        },
      });
    });

    it('should handle no expired logs', async () => {
      mockPrismaService.keyRotationAuditLog.deleteMany.mockResolvedValue({
        count: 0,
      });

      const result = await service.archiveExpiredLogs();

      expect(result).toBe(0);
    });

    it('should throw error if deletion fails', async () => {
      mockPrismaService.keyRotationAuditLog.deleteMany.mockRejectedValue(
        new Error('Database error'),
      );

      await expect(service.archiveExpiredLogs()).rejects.toThrow(
        'Database error',
      );
    });
  });

  describe('convertToPersistentFormat', () => {
    it('should convert audit log to persistent format', () => {
      const audit = {
        operation: 'GENERATE' as const,
        keyId: 'key-123',
        publicKey: 'GPUBLIC123...',
        timestamp: new Date(),
        success: true,
        errorMessage: undefined,
        metadata: { keyType: 'STELLAR_ED25519' },
      };

      const result = service.convertToPersistentFormat(audit);

      expect(result).toEqual({
        operation: 'GENERATE',
        keyId: 'key-123',
        publicKey: 'GPUBLIC123...',
        timestamp: audit.timestamp,
        success: true,
        errorMessage: undefined,
        metadata: { keyType: 'STELLAR_ED25519' },
        keyType: 'STELLAR_ED25519',
        previousKeyId: undefined,
        newKeyId: undefined,
        ipAddress: undefined,
        userAgent: undefined,
        retentionDays: undefined,
      });
    });

    it('should include additional context when provided', () => {
      const audit = {
        operation: 'SIGN' as const,
        keyId: 'key-456',
        publicKey: 'GPUBLIC456...',
        timestamp: new Date(),
        success: true,
        metadata: {},
      };

      const additionalContext = {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        retentionDays: 730,
      };

      const result = service.convertToPersistentFormat(
        audit,
        additionalContext,
      );

      expect(result.ipAddress).toBe('192.168.1.1');
      expect(result.userAgent).toBe('Mozilla/5.0');
      expect(result.retentionDays).toBe(730);
    });

    it('should extract rotation metadata', () => {
      const audit = {
        operation: 'ROTATE' as const,
        keyId: 'key-old',
        publicKey: 'GPUBLICNEW...',
        timestamp: new Date(),
        success: true,
        metadata: {
          keyType: 'STELLAR_ED25519',
          previousKeyId: 'key-old',
          newKeyId: 'key-new',
          reason: 'scheduled rotation',
        },
      };

      const result = service.convertToPersistentFormat(audit);

      expect(result.keyType).toBe('STELLAR_ED25519');
      expect(result.previousKeyId).toBe('key-old');
      expect(result.newKeyId).toBe('key-new');
    });
  });
});
