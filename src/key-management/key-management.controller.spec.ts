/**
 * KeyManagementController — unit tests
 *
 * Covers:
 *  - Feature flag guard blocks access when FEATURE_KEY_MANAGEMENT_API is unset/false
 *  - Feature flag guard allows access when FEATURE_KEY_MANAGEMENT_API=true
 *  - generateKey delegates to service and returns public fields only
 *  - sign delegates to service and returns signature fields
 *  - validateKey returns { valid } result
 *  - rotateKey returns rotation result
 *  - getAuditLog delegates and wraps in { logs }
 *  - getStatistics delegates with parsed query params
 *  - getPersistentAuditLogs delegates with parsed filters
 *  - getRotationHistory delegates by keyId
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { KeyManagementController } from './key-management.controller';
import { KeyManagementService } from './key-management.service';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';
import { InternalServiceGuard } from './guards/internal-service.guard';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { KeyType } from './domain/key-types';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException, HttpException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeEncryptedKeyMaterial = () => ({
  publicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  encryptedData: 'enc-abc',
  encryptionVersion: 1,
  keyVersion: 1,
  keyType: KeyType.STELLAR_ED25519,
});

const makeSignatureResult = () => ({
  signature: 'sig-abc',
  publicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  algorithm: 'ED25519',
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
});

// ---------------------------------------------------------------------------
// Test module factory
// ---------------------------------------------------------------------------

async function buildModule(flagEnabled: boolean) {
  const keyManagementService = {
    generateKey: jest.fn().mockResolvedValue(makeEncryptedKeyMaterial()),
    sign: jest.fn().mockResolvedValue(makeSignatureResult()),
    validateKey: jest.fn().mockResolvedValue(true),
    rotateKey: jest.fn().mockResolvedValue({
      predecessorWalletId: 'wallet-pred',
      successorWalletId: 'wallet-succ',
      successorPublicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      successorKeyVersion: 1,
    }),
    getAuditLog: jest.fn().mockReturnValue([]),
    getStatistics: jest.fn().mockReturnValue({}),
    getDetailedStatistics: jest.fn().mockReturnValue({}),
  };

  const auditService = {
    queryAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
    getRotationHistory: jest.fn().mockResolvedValue({ history: [] }),
    getAuditStatistics: jest.fn().mockResolvedValue({}),
  };

  const featureFlagService = {
    isEnabled: jest.fn().mockReturnValue(flagEnabled),
  };

  const module: TestingModule = await Test.createTestingModule({
    controllers: [KeyManagementController],
    providers: [
      { provide: KeyManagementService, useValue: keyManagementService },
      { provide: KeyRotationAuditService, useValue: auditService },
      { provide: FeatureFlagService, useValue: featureFlagService },
      Reflector,
    ],
  })
    // #690: InternalServiceGuard has its own spec; bypass it here so the
    // delegation tests exercise controller logic only.
    .overrideGuard(InternalServiceGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return {
    module,
    controller: module.get(KeyManagementController),
    keyManagementService,
    auditService,
    featureFlagService,
  };
}

// ---------------------------------------------------------------------------
// Feature flag guard — isolated unit tests
// ---------------------------------------------------------------------------

describe('KeyManagementController — FeatureFlagGuard', () => {
  it('allows access when FEATURE_KEY_MANAGEMENT_API is enabled', () => {
    const guard = new FeatureFlagGuard(
      { isEnabled: () => true } as any,
      new Reflector(),
    );

    // Build a minimal execution context that resolves the metadata from
    // the controller class (class-level @FeatureFlag decorator).
    const mockContext = {
      getHandler: () => KeyManagementController.prototype.generateKey,
      getClass: () => KeyManagementController,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(mockContext)).toBe(true);
  });

  it('throws 403 when FEATURE_KEY_MANAGEMENT_API is disabled', () => {
    const guard = new FeatureFlagGuard(
      { isEnabled: () => false } as any,
      new Reflector(),
    );

    const mockContext = {
      getHandler: () => KeyManagementController.prototype.generateKey,
      getClass: () => KeyManagementController,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(mockContext)).toThrow(HttpException);
  });

  it('throws 403 with the correct flag name in the message', () => {
    const guard = new FeatureFlagGuard(
      { isEnabled: () => false } as any,
      new Reflector(),
    );

    const mockContext = {
      getHandler: () => KeyManagementController.prototype.generateKey,
      getClass: () => KeyManagementController,
    } as unknown as ExecutionContext;

    try {
      guard.canActivate(mockContext);
      fail('Expected exception to be thrown');
    } catch (err: any) {
      expect(err.getResponse()).toMatchObject({
        statusCode: 403,
        message: expect.stringContaining('key_management_api'),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Controller delegation tests (flag bypassed via overrideGuard)
// ---------------------------------------------------------------------------

describe('KeyManagementController — delegation', () => {
  let controller: KeyManagementController;
  let keyManagementService: any;
  let auditService: any;

  beforeEach(async () => {
    const built = await buildModule(true);
    // Bypass the guard so delegation tests focus on controller logic
    controller = built.controller;
    keyManagementService = built.keyManagementService;
    auditService = built.auditService;
  });

  afterEach(() => jest.clearAllMocks());

  // generateKey
  describe('generateKey', () => {
    it('delegates to KeyManagementService.generateKey', async () => {
      const request = { keyType: KeyType.STELLAR_ED25519 };
      const result = await controller.generateKey(request);

      expect(keyManagementService.generateKey).toHaveBeenCalledWith(request);
      // Private key must NOT be in the response
      expect(result).not.toHaveProperty('privateKey');
      expect(result).not.toHaveProperty('privateKeyMaterial');
      expect(result).toHaveProperty('publicKey');
      expect(result).toHaveProperty('encryptedData');
    });
  });

  // sign
  describe('sign', () => {
    it('delegates to KeyManagementService.sign', async () => {
      const request = {
        encryptedKeyMaterial: 'enc-abc',
        dataToSign: 'hello',
        publicKey: 'GABC',
      };
      const result = await controller.sign(request);

      expect(keyManagementService.sign).toHaveBeenCalledWith(request);
      expect(result).toHaveProperty('signature');
      expect(result).toHaveProperty('publicKey');
      expect(result).toHaveProperty('algorithm');
      expect(result).toHaveProperty('timestamp');
    });
  });

  // validateKey
  describe('validateKey', () => {
    it('returns { valid: true } for a valid keypair', async () => {
      const result = await controller.validateKey({
        publicKey: 'GABC',
        encryptedKeyMaterial: 'enc-abc',
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

  describe('generateKey input validation', () => {
    it('should throw BadRequestException when keyType is missing', async () => {
      await expect(
        controller.generateKey({ keyType: undefined as any }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when keyType is invalid', async () => {
      await expect(
        controller.generateKey({ keyType: 'BOGUS' as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getAuditLog', () => {
    const mockResult = {
      data: [
        {
          operation: 'GENERATE',
          keyId: 'key-1',
          publicKey: 'GPUBLIC123...',
          timestamp: new Date(),
          success: true,
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
      hasMore: false,
    };

    it('should return paginated audit logs with default params', async () => {
      mockKeyManagementService.getAuditLog.mockReturnValue(mockResult);

      const result = await controller.getAuditLog();

      expect(result).toEqual({
        logs: mockResult.data,
        total: mockResult.total,
        limit: mockResult.limit,
        offset: mockResult.offset,
        hasMore: mockResult.hasMore,
      });
      expect(service.getAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ limit: undefined, offset: undefined }),
      );
    });

    it('should pass limit and offset to service', async () => {
      mockKeyManagementService.getAuditLog.mockReturnValue(mockResult);

      await controller.getAuditLog(undefined, undefined, undefined, undefined, undefined, '50', '10');

      expect(service.getAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, offset: 10 }),
      );
    });

    it('should pass operation filter to service', async () => {
      mockKeyManagementService.getAuditLog.mockReturnValue(mockResult);

      await controller.getAuditLog('GENERATE');

      expect(service.getAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'GENERATE' }),
      );
    });

    it('should parse success filter', async () => {
      mockKeyManagementService.getAuditLog.mockReturnValue(mockResult);

      await controller.getAuditLog(undefined, undefined, 'true');

      expect(service.getAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    });

    it('should throw BadRequestException for non-integer limit', async () => {
      await expect(
        controller.getAuditLog(undefined, undefined, undefined, undefined, undefined, 'abc'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for limit exceeding 100', async () => {
      await expect(
        controller.getAuditLog(undefined, undefined, undefined, undefined, undefined, '200'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid startDate', async () => {
      await expect(
        controller.getAuditLog(undefined, undefined, undefined, 'not-a-date'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // rotateKey
  describe('rotateKey', () => {
    it('delegates and returns rotation result with successor key version', async () => {
      const result = await controller.rotateKey({ walletId: 'wallet-pred' });

      expect(keyManagementService.rotateKey).toHaveBeenCalledWith('wallet-pred');
      expect(result).toMatchObject({
        predecessorWalletId: 'wallet-pred',
        successorWalletId: 'wallet-succ',
        successorKeyVersion: 1,
      });
    });
  });

  // getAuditLog
  describe('getAuditLog', () => {
    it('delegates with default limit and wraps result in { logs }', async () => {
      const result = await controller.getAuditLog(undefined);

      expect(keyManagementService.getAuditLog).toHaveBeenCalledWith(100);
      expect(result).toHaveProperty('logs');
    });

    it('parses limit query param', async () => {
      await controller.getAuditLog('50');

      expect(keyManagementService.getAuditLog).toHaveBeenCalledWith(50);
    });
  });

  // getStatistics
  describe('getStatistics', () => {
    it('passes undefined dates when no params provided', async () => {
      await controller.getStatistics(undefined, undefined, undefined);

      expect(keyManagementService.getStatistics).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: undefined,
          endDate: undefined,
          operation: undefined,
        }),
      );
    });

    it('parses ISO date strings into Date objects', async () => {
      await controller.getStatistics('2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z', 'SIGN');

      expect(keyManagementService.getStatistics).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date),
          operation: 'SIGN',
        }),
      );
    });
  });

  // getPersistentAuditLogs
  describe('getPersistentAuditLogs', () => {
    it('delegates to auditService.queryAuditLogs with defaults', async () => {
      await controller.getPersistentAuditLogs();

      expect(auditService.queryAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100, offset: 0 }),
      );
    });
  });

  // getRotationHistory
  describe('getRotationHistory', () => {
    it('delegates with the provided keyId', async () => {
      await controller.getRotationHistory('key-123');

      expect(auditService.getRotationHistory).toHaveBeenCalledWith('key-123');
    });
  });
});
