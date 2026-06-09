import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KeyManagementService } from './key-management.service';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyType } from './domain/key-types';
import { KeyStatisticsQuery } from './domain/key-statistics';

import { KeyRotationAuditService } from './key-rotation-audit.service';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

import { PrismaService } from '../prisma/prisma.service';

describe('KeyManagementService - Statistics', () => {
  let service: KeyManagementService;
  let encryptionService: EncryptionService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key-12345'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyManagementService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: PrismaService,
          useValue: { wallet: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() }, $transaction: jest.fn() },
        },
        {
          provide: KeyRotationAuditService,
          useValue: {
            persistAuditLog: jest.fn().mockResolvedValue(undefined),
            convertToPersistentFormat: jest.fn().mockReturnValue({}),
          },
        },
      ],
    }).compile();

    service = module.get<KeyManagementService>(KeyManagementService);
    encryptionService = module.get<EncryptionService>(EncryptionService);

    // Reset statistics before each test
    service.resetStatistics();
  });

  describe('getStatistics', () => {
    it('should return empty statistics when no operations performed', () => {
      const stats = service.getStatistics();

      expect(stats.totalKeysGenerated).toBe(0);
      expect(stats.totalSigningOperations).toBe(0);
      expect(stats.totalValidations).toBe(0);
      expect(stats.totalFailures).toBe(0);
      expect(stats.successRate).toBe(100);
      expect(stats.keysByType).toEqual({});
      expect(stats.operationsByType).toEqual({});
    });

    it('should track key generation operations', async () => {
      // Generate 3 keys
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const stats = service.getStatistics();

      expect(stats.totalKeysGenerated).toBe(3);
      expect(stats.operationsByType.GENERATE).toBe(3);
      expect(stats.successRate).toBe(100);
      expect(stats.lastOperation).toBeDefined();
    });

    it('should track signing operations', async () => {
      // Generate a key first
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Sign multiple times
      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('test1'),
        publicKey: keyMaterial.publicKey,
      });

      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('test2'),
        publicKey: keyMaterial.publicKey,
      });

      const stats = service.getStatistics();

      expect(stats.totalSigningOperations).toBe(2);
      expect(stats.operationsByType.SIGN).toBe(2);
    });

    it('should calculate correct success rate', async () => {
      // Generate some successful operations
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      // Force a failure by using invalid key type
      try {
        await service.generateKey({
          keyType: 'INVALID_TYPE' as KeyType,
        });
      } catch (error) {
        // Expected to fail
      }

      const stats = service.getStatistics();

      // 2 successful, 1 failed = 2/3 = 66.67% success rate
      expect(stats.totalFailures).toBe(1);
      expect(stats.successRate).toBeCloseTo(66.67, 1);
    });

    it('should filter by date range', async () => {
      // Generate keys
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      // Get statistics for a future date range (should be empty)
      const futureQuery: KeyStatisticsQuery = {
        startDate: new Date('2099-01-01'),
        endDate: new Date('2099-12-31'),
      };

      const futureStats = service.getStatistics(futureQuery);
      expect(futureStats.totalKeysGenerated).toBe(0);

      // Get statistics for all time
      const allTimeQuery: KeyStatisticsQuery = {
        startDate: new Date('2000-01-01'),
        endDate: new Date(),
      };

      const allTimeStats = service.getStatistics(allTimeQuery);
      expect(allTimeStats.totalKeysGenerated).toBe(2);
    });

    it('should filter by operation type', async () => {
      // Generate a key
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Sign data
      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('test'),
        publicKey: keyMaterial.publicKey,
      });

      // Get only GENERATE operations
      const generateQuery: KeyStatisticsQuery = {
        operation: 'GENERATE',
      };

      const generateStats = service.getStatistics(generateQuery);
      expect(generateStats.totalKeysGenerated).toBe(1);
      expect(generateStats.totalSigningOperations).toBe(0);

      // Get only SIGN operations
      const signQuery: KeyStatisticsQuery = {
        operation: 'SIGN',
      };

      const signStats = service.getStatistics(signQuery);
      expect(signStats.totalKeysGenerated).toBe(0);
      expect(signStats.totalSigningOperations).toBe(1);
    });

    it('should count keys by type', async () => {
      // Generate multiple Stellar keys
      await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { keyType: 'STELLAR_ED25519' },
      });
      await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { keyType: 'STELLAR_ED25519' },
      });

      const stats = service.getStatistics();

      expect(stats.keysByType.STELLAR_ED25519).toBe(2);
    });
  });

  describe('getDetailedStatistics', () => {
    it('should include operation metrics', async () => {
      // Generate keys
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Sign
      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('test'),
        publicKey: keyMaterial.publicKey,
      });

      const stats = service.getDetailedStatistics();

      expect(stats.operationMetrics).toBeDefined();
      expect(stats.operationMetrics.length).toBeGreaterThan(0);

      // Find GENERATE metrics
      const generateMetrics = stats.operationMetrics.find(
        (m) => m.operation === 'GENERATE',
      );
      expect(generateMetrics).toBeDefined();
      expect(generateMetrics?.count).toBe(3);
      expect(generateMetrics?.successCount).toBe(3);
      expect(generateMetrics?.failureCount).toBe(0);
      expect(generateMetrics?.successRate).toBe(100);

      // Find SIGN metrics
      const signMetrics = stats.operationMetrics.find(
        (m) => m.operation === 'SIGN',
      );
      expect(signMetrics).toBeDefined();
      expect(signMetrics?.count).toBe(1);
    });

    it('should include recent operations', async () => {
      // Generate a key
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const stats = service.getDetailedStatistics();

      expect(stats.recentOperations).toBeDefined();
      expect(stats.recentOperations.length).toBe(1);
      expect(stats.recentOperations[0].operation).toBe('GENERATE');
      expect(stats.recentOperations[0].success).toBe(true);
      expect(stats.recentOperations[0].timestamp).toBeDefined();
    });

    it('should limit recent operations to 10', async () => {
      // Generate 15 keys
      for (let i = 0; i < 15; i++) {
        await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      }

      const stats = service.getDetailedStatistics();

      expect(stats.recentOperations.length).toBe(10);
    });

    it('should include time series when requested', async () => {
      // Generate keys
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const stats = service.getDetailedStatistics({
        includeTimeSeries: true,
      });

      expect(stats.timeSeries).toBeDefined();
      expect(Array.isArray(stats.timeSeries)).toBe(true);
    });

    it('should not include time series by default', async () => {
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const stats = service.getDetailedStatistics();

      expect(stats.timeSeries).toBeUndefined();
    });

    it('should show failure metrics correctly', async () => {
      // Success
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      // Failure
      try {
        await service.generateKey({
          keyType: 'INVALID' as KeyType,
        });
      } catch (error) {
        // Expected
      }

      const stats = service.getDetailedStatistics();

      const generateMetrics = stats.operationMetrics.find(
        (m) => m.operation === 'GENERATE',
      );

      expect(generateMetrics?.count).toBe(2);
      expect(generateMetrics?.successCount).toBe(1);
      expect(generateMetrics?.failureCount).toBe(1);
      expect(generateMetrics?.successRate).toBe(50);
    });
  });

  describe('resetStatistics', () => {
    it('should clear all statistics', async () => {
      // Generate some keys
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      let stats = service.getStatistics();
      expect(stats.totalKeysGenerated).toBe(2);

      // Reset
      service.resetStatistics();

      stats = service.getStatistics();
      expect(stats.totalKeysGenerated).toBe(0);
      expect(stats.operationsByType).toEqual({});
    });
  });

  describe('complex scenarios', () => {
    it('should track mixed operations correctly', async () => {
      // Generate 3 keys
      const key1 = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      const key2 = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      // Sign with first key twice
      await service.sign({
        encryptedKeyMaterial: key1.encryptedData,
        dataToSign: Buffer.from('tx1'),
        publicKey: key1.publicKey,
      });

      await service.sign({
        encryptedKeyMaterial: key1.encryptedData,
        dataToSign: Buffer.from('tx2'),
        publicKey: key1.publicKey,
      });

      // Sign with second key once
      await service.sign({
        encryptedKeyMaterial: key2.encryptedData,
        dataToSign: Buffer.from('tx3'),
        publicKey: key2.publicKey,
      });

      // Validate first key
      await service.validateKey(
        key1.publicKey,
        key1.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      const stats = service.getDetailedStatistics();

      expect(stats.totalKeysGenerated).toBe(3);
      expect(stats.totalSigningOperations).toBe(3);
      expect(stats.successRate).toBe(100);

      // Check operation counts
      const generateMetrics = stats.operationMetrics.find(
        (m) => m.operation === 'GENERATE',
      );
      const signMetrics = stats.operationMetrics.find(
        (m) => m.operation === 'SIGN',
      );

      expect(generateMetrics?.count).toBe(3);
      expect(signMetrics?.count).toBe(3);
    });
  });
});
