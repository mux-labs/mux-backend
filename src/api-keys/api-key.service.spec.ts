import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from './api-key.service';
import { ApiKeyStatus } from './domain/api-key.model';
import * as crypto from 'crypto';

// Mock PrismaClient
jest.mock('../generated/prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn(),
      },
      apiKey: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      apiKeyUsage: {
        create: jest.fn(),
      },
    })),
  };
});

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let mockPrisma: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockPrisma = {
      project: {
        findUnique: jest.fn(),
      },
      apiKey: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      apiKeyUsage: {
        create: jest.fn(),
      },
    };

    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'API_KEY_ROTATION_GRACE_SECONDS') {
          return 3600;
        }
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ApiKeyService>(ApiKeyService);
    service['prisma'] = mockPrisma;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createApiKey - Issue #154', () => {
    it('should hash the API key before storage', async () => {
      const projectId = 'test-project-id';
      const mockProject = {
        id: projectId,
        environment: 'production',
      };

      mockPrisma.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        keyHash: expect.any(String),
        keyPrefix: 'mux_live_',
        lastFour: expect.any(String),
        projectId,
        status: ApiKeyStatus.ACTIVE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.createApiKey({
        name: 'Test Key',
        projectId,
      });

      // Verify plaintext key is returned exactly once
      expect(result.plainTextKey).toBeDefined();
      expect(result.plainTextKey).toMatch(/^mux_live_/);

      // Verify the hash was created (not plaintext stored)
      const createCall = mockPrisma.apiKey.create.mock.calls[0][0];
      expect(createCall.data.keyHash).toBeDefined();
      expect(createCall.data.keyHash).not.toBe(result.plainTextKey);

      // Verify hash matches the plaintext key
      const expectedHash = crypto
        .createHash('sha256')
        .update(result.plainTextKey)
        .digest('hex');
      expect(createCall.data.keyHash).toBe(expectedHash);
    });

    it('should return plaintext key exactly once in create response', async () => {
      const projectId = 'test-project-id';
      const mockProject = {
        id: projectId,
        environment: 'test',
      };

      mockPrisma.project.findUnique.mockResolvedValue(mockProject);
      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        keyHash: 'hash',
        keyPrefix: 'mux_test_',
        lastFour: expect.any(String),
        projectId,
        status: ApiKeyStatus.ACTIVE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.createApiKey({
        name: 'Test Key',
        projectId,
      });

      expect(result.plainTextKey).toBeDefined();
      expect(result.plainTextKey.startsWith('mux_test_')).toBe(true);
    });
  });

  describe('validateApiKey - Issue #154', () => {
    it('should reject invalid API key format', async () => {
      await expect(service.validateApiKey('invalid-key')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject non-existent API key', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(
        service.validateApiKey('mux_test_nonexistent'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should validate and accept correct API key', async () => {
      const plainTextKey = 'mux_test_validkey123456789012345';
      const keyHash = crypto
        .createHash('sha256')
        .update(plainTextKey)
        .digest('hex');

      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        keyHash,
        keyPrefix: 'mux_test_',
        lastFour: '5678',
        projectId: 'project-id',
        status: ApiKeyStatus.ACTIVE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        project: {
          id: 'project-id',
          developer: { id: 'dev-id', email: 'dev@example.com' },
        },
      });

      const result = await service.validateApiKey(plainTextKey);

      expect(result.apiKey).toBeDefined();
      expect(result.apiKey.id).toBe('key-id');
      expect(result.project).toBeDefined();
      expect(result.developer).toBeDefined();
    });

    it('should reject incorrect API key', async () => {
      const correctKey = 'mux_test_correct123456789012345';
      const correctKeyHash = crypto
        .createHash('sha256')
        .update(correctKey)
        .digest('hex');

      mockPrisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(
        service.validateApiKey('mux_test_incorrect123456789012345'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject revoked API key', async () => {
      const plainTextKey = 'mux_test_validkey123456789012345';
      const keyHash = crypto
        .createHash('sha256')
        .update(plainTextKey)
        .digest('hex');

      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        keyHash,
        keyPrefix: 'mux_test_',
        lastFour: '5678',
        projectId: 'project-id',
        status: ApiKeyStatus.REVOKED,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: new Date(),
        revokedReason: 'Manual revocation',
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        project: {
          id: 'project-id',
          developer: { id: 'dev-id', email: 'dev@example.com' },
        },
      });

      await expect(service.validateApiKey(plainTextKey)).rejects.toThrow(
        /revoked/i,
      );
    });
  });

  describe('revokeApiKey - Issue #155', () => {
    it('should revoke an active API key', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        keyHash: 'hash',
        keyPrefix: 'mux_test_',
        lastFour: '5678',
        projectId: 'project-id',
        status: ApiKeyStatus.ACTIVE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        project: { developerId: 'dev-id' },
      });

      mockPrisma.apiKey.update.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        keyHash: 'hash',
        keyPrefix: 'mux_test_',
        lastFour: '5678',
        projectId: 'project-id',
        status: ApiKeyStatus.REVOKED,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: new Date(),
        revokedReason: 'Manual revocation',
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.revokeApiKey(
        'key-id',
        'Manual revocation',
        'dev-id',
      );

      expect(result.status).toBe(ApiKeyStatus.REVOKED);
      expect(result.revokedAt).toBeDefined();
      expect(result.revokedReason).toBe('Manual revocation');
    });

    it('should be idempotent when revoking already-revoked key', async () => {
      const revokedKey = {
        id: 'key-id',
        name: 'Test Key',
        keyHash: 'hash',
        keyPrefix: 'mux_test_',
        lastFour: '5678',
        projectId: 'project-id',
        status: ApiKeyStatus.REVOKED,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: new Date(),
        revokedReason: 'Previous revocation',
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        project: { developerId: 'dev-id' },
      };

      mockPrisma.apiKey.findUnique.mockResolvedValue(revokedKey);

      const result = await service.revokeApiKey('key-id', undefined, 'dev-id');

      expect(result.status).toBe(ApiKeyStatus.REVOKED);
      // Should not call update if already revoked
      expect(mockPrisma.apiKey.update).not.toHaveBeenCalled();
    });

    it('should reject unauthorized revoke attempt', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        status: ApiKeyStatus.ACTIVE,
        project: { developerId: 'dev-1' },
      });

      await expect(
        service.revokeApiKey('key-id', undefined, 'dev-2'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('listApiKeys - Issue #156', () => {
    it('should list API keys for a project with pagination', async () => {
      mockPrisma.apiKey.findMany.mockResolvedValue([
        {
          id: 'key-1',
          name: 'Key 1',
          keyHash: 'hash1',
          keyPrefix: 'mux_test_',
          lastFour: '0001',
          projectId: 'project-id',
          status: ApiKeyStatus.ACTIVE,
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          revokedReason: null,
          gracePeriodEndsAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      mockPrisma.apiKey.count.mockResolvedValue(5);

      const result = await service.listApiKeys({
        projectId: 'project-id',
        page: 1,
        pageSize: 10,
      });

      expect(result.keys.length).toBe(1);
      expect(result.total).toBe(5);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });

    it('should verify developer ownership when developerId provided', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'project-id',
        developerId: 'dev-1',
      });

      mockPrisma.apiKey.findMany.mockResolvedValue([]);
      mockPrisma.apiKey.count.mockResolvedValue(0);

      const result = await service.listApiKeys({
        projectId: 'project-id',
        developerId: 'dev-1',
        page: 1,
        pageSize: 10,
      });

      expect(result.keys).toEqual([]);
    });

    it('should reject unauthorized list attempt', async () => {
      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'project-id',
        developerId: 'dev-1',
      });

      await expect(
        service.listApiKeys({
          projectId: 'project-id',
          developerId: 'dev-2',
          page: 1,
          pageSize: 10,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('rotateApiKey - Issue #157', () => {
    it('should rotate API key and set grace period', async () => {
      const oldKeyId = 'old-key-id';
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: oldKeyId,
        name: 'Old Key',
        keyHash: 'old-hash',
        keyPrefix: 'mux_test_',
        lastFour: '0001',
        projectId: 'project-id',
        status: ApiKeyStatus.ACTIVE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        project: {
          id: 'project-id',
          environment: 'test',
          developerId: 'dev-id',
        },
      });

      mockPrisma.project.findUnique.mockResolvedValue({
        id: 'project-id',
        environment: 'test',
      });

      mockPrisma.apiKey.create.mockResolvedValue({
        id: 'new-key-id',
        name: 'Old Key (rotated)',
        keyHash: 'new-hash',
        keyPrefix: 'mux_test_',
        lastFour: '0002',
        projectId: 'project-id',
        status: ApiKeyStatus.ACTIVE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        gracePeriodEndsAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockPrisma.apiKey.update.mockResolvedValue({
        id: oldKeyId,
        status: ApiKeyStatus.ACTIVE,
        gracePeriodEndsAt: expect.any(Date),
      });

      const result = await service.rotateApiKey(
        { apiKeyId: oldKeyId },
        'dev-id',
      );

      expect(result.plainTextKey).toBeDefined();
      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: oldKeyId },
        data: {
          gracePeriodEndsAt: expect.any(Date),
        },
      });
    });

    it('should reject unauthorized rotate attempt', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-id',
        name: 'Test Key',
        projectId: 'project-id',
        project: { developerId: 'dev-1' },
      });

      await expect(
        service.rotateApiKey({ apiKeyId: 'key-id' }, 'dev-2'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
