import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyStatus } from './domain/api-key.model';
import { ConfigService } from '@nestjs/config';

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
  let createdKeys: any[];

  beforeEach(async () => {
    createdKeys = [];

    mockPrisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'project-123',
          environment: 'development',
          developerId: 'developer-123',
        }),
      },
      apiKey: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          const key = {
            id: `apiKey-${createdKeys.length + 1}`,
            name: data.name,
            keyHash: data.keyHash,
            keyPrefix: data.keyPrefix,
            lastFour: data.lastFour,
            projectId: data.projectId,
            status: data.status,
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: data.expiresAt,
            lastUsedAt: null,
            revokedAt: null,
            revokedReason: null,
            gracePeriodEndsAt: null,
          };
          createdKeys.push(key);
          return key;
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          if (where?.id) {
            return createdKeys.find((key) => key.id === where.id) || null;
          }

          if (where?.keyHash) {
            const key = createdKeys.find((record) => record.keyHash === where.keyHash);
            if (!key) {
              return null;
            }
            return {
              ...key,
              project: {
                id: key.projectId,
                developerId: 'developer-123',
                developer: {
                  id: 'developer-123',
                },
              },
            };
          }

          return null;
        }),
        findMany: jest.fn().mockImplementation(async ({ where, skip, take }) => {
          const matching = createdKeys.filter((key) => key.projectId === where.projectId);
          return matching.slice(skip ?? 0, (skip ?? 0) + (take ?? matching.length));
        }),
        count: jest.fn().mockImplementation(async ({ where }) => {
          return createdKeys.filter((key) => key.projectId === where.projectId).length;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const key = createdKeys.find((record) => record.id === where.id);
          if (!key) {
            return null;
          }
          Object.assign(key, data);
          return key;
        }),
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

  describe('createApiKey', () => {
    it('should return plaintext key only on creation', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      expect(result.plainTextKey).toBeDefined();
      expect(result.plainTextKey).toMatch(/^mux_(live|test)_/);
      expect(result.plainTextKey.length).toBeGreaterThan(20);
    });

    it('should not include plaintext key in stored ApiKey object', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      expect(result.apiKey).toBeDefined();
      expect((result.apiKey as any).plainTextKey).toBeUndefined();
    });

    it('should store hashed key not plaintext', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      expect(result.apiKey.keyHash).toBeDefined();
      expect(result.apiKey.keyHash).not.toEqual(result.plainTextKey);
      expect(result.apiKey.keyHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should include key metadata in response', async () => {
      const result = await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      expect(result.apiKey.id).toBeDefined();
      expect(result.apiKey.name).toBe('test-key');
      expect(result.apiKey.keyPrefix).toMatch(/^mux_(live|test)_/);
      expect(result.apiKey.lastFour).toMatch(/^[a-zA-Z0-9_-]{4}$/);
      expect(result.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
      expect(result.apiKey.createdAt).toBeDefined();
    });
  });

  describe('listApiKeys', () => {
    it('should return only metadata without keys or hashes', async () => {
      await service.createApiKey({
        name: 'test-key',
        projectId: 'project-123',
      });

      const result = await service.listApiKeys({ projectId: 'project-123' });

      expect(result.keys.length).toBeGreaterThan(0);
      result.keys.forEach((key) => {
        expect(key.id).toBeDefined();
        expect(key.name).toBeDefined();
        expect(key.keyPrefix).toBeDefined();
        expect(key.lastFour).toBeDefined();
        expect(key.status).toBeDefined();
        expect((key as any).plainTextKey).toBeUndefined();
      });
    });
  });

  describe('validateApiKey', () => {
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

    it('should reject expired API key', async () => {
      const result = await service.createApiKey({
        name: 'expiring-key',
        projectId: 'project-123',
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(
        service.validateApiKey(result.plainTextKey),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should validate active API key successfully', async () => {
      const createResult = await service.createApiKey({
        name: 'active-key',
        projectId: 'project-123',
      });

      const validateResult = await service.validateApiKey(
        createResult.plainTextKey,
      );

      expect(validateResult.apiKey).toBeDefined();
      expect(validateResult.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });
  });

  describe('rotateApiKey', () => {
    it('should return plaintext key only for new rotated key', async () => {
      const createResult = await service.createApiKey({
        name: 'original-key',
        projectId: 'project-123',
      });

      const rotateResult = await service.rotateApiKey({
        apiKeyId: createResult.apiKey.id,
      });

      expect(rotateResult.plainTextKey).toBeDefined();
      expect(rotateResult.plainTextKey).not.toEqual(
        createResult.plainTextKey,
      );
    });

    it('should keep old key valid during grace period after rotation', async () => {
      const createResult = await service.createApiKey({
        name: 'original-key',
        projectId: 'project-123',
      });

      const rotateResult = await service.rotateApiKey({
        apiKeyId: createResult.apiKey.id,
      });

      const oldResult = await service.validateApiKey(createResult.plainTextKey);
      expect(oldResult.apiKey).toBeDefined();
      expect(oldResult.apiKey.status).toBe(ApiKeyStatus.ACTIVE);

      const newResult = await service.validateApiKey(
        rotateResult.plainTextKey,
      );
      expect(newResult.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });
  });
});
