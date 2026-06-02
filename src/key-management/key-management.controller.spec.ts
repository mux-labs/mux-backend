import { Test, TestingModule } from '@nestjs/testing';
import { KeyManagementController } from './key-management.controller';
import { KeyManagementService } from './key-management.service';
import { KeyType } from './domain/key-types';
import {
  KeyStatistics,
  DetailedKeyStatistics,
} from './domain/key-statistics';

describe('KeyManagementController', () => {
  let controller: KeyManagementController;
  let service: KeyManagementService;

  const mockKeyManagementService = {
    generateKey: jest.fn(),
    sign: jest.fn(),
    validateKey: jest.fn(),
    getAuditLog: jest.fn(),
    getStatistics: jest.fn(),
    getDetailedStatistics: jest.fn(),
    resetStatistics: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [KeyManagementController],
      providers: [
        {
          provide: KeyManagementService,
          useValue: mockKeyManagementService,
        },
      ],
    }).compile();

    controller = module.get<KeyManagementController>(
      KeyManagementController,
    );
    service = module.get<KeyManagementService>(KeyManagementService);

    // Reset mocks
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('generateKey', () => {
    it('should generate a key and return encrypted material', async () => {
      const mockResult = {
        encryptedData: 'encrypted-key-data',
        publicKey: 'GPUBLIC123...',
        keyType: KeyType.STELLAR_ED25519,
        encryptionVersion: 1,
      };

      mockKeyManagementService.generateKey.mockResolvedValue(mockResult);

      const result = await controller.generateKey({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { test: 'data' },
      });

      expect(result).toEqual(mockResult);
      expect(service.generateKey).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { test: 'data' },
      });
    });
  });

  describe('sign', () => {
    it('should sign data and return signature', async () => {
      const mockSignature = {
        signature: 'signature-data',
        publicKey: 'GPUBLIC123...',
        algorithm: 'ed25519',
        timestamp: new Date(),
      };

      mockKeyManagementService.sign.mockResolvedValue(mockSignature);

      const result = await controller.sign({
        encryptedKeyMaterial: 'encrypted-data',
        dataToSign: Buffer.from('test-data'),
        publicKey: 'GPUBLIC123...',
      });

      expect(result).toEqual(mockSignature);
      expect(service.sign).toHaveBeenCalled();
    });
  });

  describe('validateKey', () => {
    it('should validate a keypair', async () => {
      mockKeyManagementService.validateKey.mockResolvedValue(true);

      const result = await controller.validateKey({
        publicKey: 'GPUBLIC123...',
        encryptedKeyMaterial: 'encrypted-data',
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(result).toEqual({ valid: true });
      expect(service.validateKey).toHaveBeenCalledWith(
        'GPUBLIC123...',
        'encrypted-data',
        KeyType.STELLAR_ED25519,
      );
    });
  });

  describe('getAuditLog', () => {
    it('should return audit logs with default limit', async () => {
      const mockLogs = [
        {
          operation: 'GENERATE',
          keyId: 'key-1',
          publicKey: 'GPUBLIC123...',
          timestamp: new Date(),
          success: true,
        },
      ];

      mockKeyManagementService.getAuditLog.mockReturnValue(mockLogs);

      const result = await controller.getAuditLog();

      expect(result).toEqual({ logs: mockLogs });
      expect(service.getAuditLog).toHaveBeenCalledWith(100);
    });

    it('should return audit logs with custom limit', async () => {
      const mockLogs = [];
      mockKeyManagementService.getAuditLog.mockReturnValue(mockLogs);

      await controller.getAuditLog('50');

      expect(service.getAuditLog).toHaveBeenCalledWith(50);
    });
  });

  describe('getStatistics', () => {
    it('should return statistics without query parameters', async () => {
      const mockStats: KeyStatistics = {
        totalKeysGenerated: 10,
        totalSigningOperations: 25,
        totalValidations: 5,
        totalFailures: 1,
        keysByType: { STELLAR_ED25519: 10 },
        operationsByType: { GENERATE: 10, SIGN: 25, ACCESS: 5 },
        successRate: 97.5,
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date(),
      };

      mockKeyManagementService.getStatistics.mockReturnValue(mockStats);

      const result = await controller.getStatistics();

      expect(result).toEqual({
        success: true,
        data: mockStats,
      });
      expect(service.getStatistics).toHaveBeenCalledWith({
        startDate: undefined,
        endDate: undefined,
        operation: undefined,
      });
    });

    it('should return statistics with date range', async () => {
      const mockStats: KeyStatistics = {
        totalKeysGenerated: 5,
        totalSigningOperations: 10,
        totalValidations: 2,
        totalFailures: 0,
        keysByType: { STELLAR_ED25519: 5 },
        operationsByType: { GENERATE: 5, SIGN: 10 },
        successRate: 100,
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date('2024-12-31'),
      };

      mockKeyManagementService.getStatistics.mockReturnValue(mockStats);

      await controller.getStatistics('2024-01-01', '2024-12-31');

      expect(service.getStatistics).toHaveBeenCalledWith({
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
        operation: undefined,
      });
    });

    it('should return statistics filtered by operation', async () => {
      const mockStats: KeyStatistics = {
        totalKeysGenerated: 5,
        totalSigningOperations: 0,
        totalValidations: 0,
        totalFailures: 0,
        keysByType: { STELLAR_ED25519: 5 },
        operationsByType: { GENERATE: 5 },
        successRate: 100,
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date(),
      };

      mockKeyManagementService.getStatistics.mockReturnValue(mockStats);

      await controller.getStatistics(undefined, undefined, 'GENERATE');

      expect(service.getStatistics).toHaveBeenCalledWith({
        startDate: undefined,
        endDate: undefined,
        operation: 'GENERATE',
      });
    });
  });

  describe('getDetailedStatistics', () => {
    it('should return detailed statistics without time series by default', async () => {
      const mockDetailedStats: DetailedKeyStatistics = {
        totalKeysGenerated: 10,
        totalSigningOperations: 25,
        totalValidations: 5,
        totalFailures: 1,
        keysByType: { STELLAR_ED25519: 10 },
        operationsByType: { GENERATE: 10, SIGN: 25, ACCESS: 5 },
        successRate: 97.5,
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date(),
        operationMetrics: [
          {
            operation: 'GENERATE',
            count: 10,
            successCount: 10,
            failureCount: 0,
            successRate: 100,
          },
          {
            operation: 'SIGN',
            count: 25,
            successCount: 24,
            failureCount: 1,
            successRate: 96,
          },
        ],
        recentOperations: [
          {
            operation: 'SIGN',
            timestamp: new Date(),
            success: true,
            keyType: 'STELLAR_ED25519',
          },
        ],
      };

      mockKeyManagementService.getDetailedStatistics.mockReturnValue(
        mockDetailedStats,
      );

      const result = await controller.getDetailedStatistics();

      expect(result).toEqual({
        success: true,
        data: mockDetailedStats,
      });
      expect(service.getDetailedStatistics).toHaveBeenCalledWith({
        startDate: undefined,
        endDate: undefined,
        operation: undefined,
        includeTimeSeries: false,
      });
    });

    it('should return detailed statistics with time series when requested', async () => {
      const mockDetailedStats: DetailedKeyStatistics = {
        totalKeysGenerated: 10,
        totalSigningOperations: 25,
        totalValidations: 5,
        totalFailures: 1,
        keysByType: { STELLAR_ED25519: 10 },
        operationsByType: { GENERATE: 10, SIGN: 25, ACCESS: 5 },
        successRate: 97.5,
        periodStart: new Date('2024-01-01'),
        periodEnd: new Date(),
        operationMetrics: [],
        recentOperations: [],
        timeSeries: [
          {
            timestamp: new Date('2024-01-01T10:00:00Z'),
            count: 5,
            operation: 'GENERATE',
          },
          {
            timestamp: new Date('2024-01-01T11:00:00Z'),
            count: 3,
            operation: 'SIGN',
          },
        ],
      };

      mockKeyManagementService.getDetailedStatistics.mockReturnValue(
        mockDetailedStats,
      );

      const result = await controller.getDetailedStatistics(
        undefined,
        undefined,
        undefined,
        'true',
      );

      expect(result.data.timeSeries).toBeDefined();
      expect(result.data.timeSeries?.length).toBe(2);
      expect(service.getDetailedStatistics).toHaveBeenCalledWith({
        startDate: undefined,
        endDate: undefined,
        operation: undefined,
        includeTimeSeries: true,
      });
    });

    it('should handle all query parameters', async () => {
      const mockDetailedStats: DetailedKeyStatistics = {
        totalKeysGenerated: 3,
        totalSigningOperations: 0,
        totalValidations: 0,
        totalFailures: 0,
        keysByType: {},
        operationsByType: { GENERATE: 3 },
        successRate: 100,
        periodStart: new Date('2024-06-01'),
        periodEnd: new Date('2024-06-30'),
        operationMetrics: [],
        recentOperations: [],
      };

      mockKeyManagementService.getDetailedStatistics.mockReturnValue(
        mockDetailedStats,
      );

      await controller.getDetailedStatistics(
        '2024-06-01',
        '2024-06-30',
        'GENERATE',
        'true',
      );

      expect(service.getDetailedStatistics).toHaveBeenCalledWith({
        startDate: new Date('2024-06-01'),
        endDate: new Date('2024-06-30'),
        operation: 'GENERATE',
        includeTimeSeries: true,
      });
    });
  });
});
