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
            const key = createdKeys.find(
              (record) => record.keyHash === where.keyHash,
            );
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
        findMany: jest
          .fn()
          .mockImplementation(async ({ where, skip, take }) => {
            const matching = createdKeys.filter(
              (key) => key.projectId === where.projectId,
            );
            return matching.slice(
              skip ?? 0,
              (skip ?? 0) + (take ?? matching.length),
            );
          }),
        count: jest.fn().mockImplementation(async ({ where }) => {
          return createdKeys.filter((key) => key.projectId === where.projectId)
            .length;
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

      await expect(service.validateApiKey(result.plainTextKey)).rejects.toThrow(
        UnauthorizedException,
      );
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
      expect(rotateResult.plainTextKey).not.toEqual(createResult.plainTextKey);
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

      const newResult = await service.validateApiKey(rotateResult.plainTextKey);
      expect(newResult.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });
  });

  // ---------------------------------------------------------------------------
  // API_KEY_DEFAULT_EXPIRY_DAYS enforcement
  // ---------------------------------------------------------------------------

  describe('createApiKey — API_KEY_DEFAULT_EXPIRY_DAYS', () => {
    let serviceWithExpiry: ApiKeyService;
    let prismaWithExpiry: any;
    let keysWithExpiry: any[];

    beforeEach(async () => {
      keysWithExpiry = [];

      prismaWithExpiry = {
        project: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'project-expiry',
            environment: 'development',
            developerId: 'developer-expiry',
          }),
        },
        apiKey: {
          create: jest.fn().mockImplementation(async ({ data }) => {
            const key = {
              id: `expiry-key-${keysWithExpiry.length + 1}`,
              name: data.name,
              keyHash: data.keyHash,
              keyPrefix: data.keyPrefix,
              lastFour: data.lastFour,
              projectId: data.projectId,
              status: data.status,
              createdAt: new Date(),
              updatedAt: new Date(),
              expiresAt: data.expiresAt ?? null,
              lastUsedAt: null,
              revokedAt: null,
              revokedReason: null,
              gracePeriodEndsAt: null,
              network: null,
            };
            keysWithExpiry.push(key);
            return key;
          }),
          findUnique: jest.fn().mockImplementation(async ({ where }) => {
            if (where?.id) {
              return (
                keysWithExpiry.find((k) => k.id === where.id) || null
              );
            }
            if (where?.keyHash) {
              const key = keysWithExpiry.find(
                (k) => k.keyHash === where.keyHash,
              );
              if (!key) return null;
              return {
                ...key,
                project: {
                  id: key.projectId,
                  developerId: 'developer-expiry',
                  developer: { id: 'developer-expiry' },
                },
              };
            }
            return null;
          }),
          update: jest.fn().mockImplementation(async ({ where, data }) => {
            const key = keysWithExpiry.find((k) => k.id === where.id);
            if (key) Object.assign(key, data);
            return key;
          }),
        },
        apiKeyUsage: { create: jest.fn() },
      };

      // ConfigService that returns API_KEY_DEFAULT_EXPIRY_DAYS = 30
      const configWithExpiry = {
        get: jest.fn((key: string) => {
          if (key === 'API_KEY_ROTATION_GRACE_SECONDS') return 3600;
          if (key === 'API_KEY_DEFAULT_EXPIRY_DAYS') return 30;
          return undefined;
        }),
      };

      const module = await Test.createTestingModule({
        providers: [
          ApiKeyService,
          { provide: ConfigService, useValue: configWithExpiry },
        ],
      }).compile();

      serviceWithExpiry = module.get<ApiKeyService>(ApiKeyService);
      serviceWithExpiry['prisma'] = prismaWithExpiry;
    });

    it('sets expiresAt ~30 days in the future when API_KEY_DEFAULT_EXPIRY_DAYS=30 and caller omits expiresAt', async () => {
      const before = Date.now();
      const result = await serviceWithExpiry.createApiKey({
        name: 'auto-expiry-key',
        projectId: 'project-expiry',
      });
      const after = Date.now();

      expect(result.apiKey.expiresAt).toBeDefined();
      const expires = result.apiKey.expiresAt!.getTime();
      const expectedMin = before + 30 * 24 * 60 * 60 * 1000;
      const expectedMax = after + 30 * 24 * 60 * 60 * 1000;

      expect(expires).toBeGreaterThanOrEqual(expectedMin);
      expect(expires).toBeLessThanOrEqual(expectedMax);
    });

    it('explicit expiresAt from caller overrides the default expiry', async () => {
      const explicitExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const result = await serviceWithExpiry.createApiKey({
        name: 'explicit-expiry-key',
        projectId: 'project-expiry',
        expiresAt: explicitExpiry,
      });

      // Should be within 1 second of the explicit date
      expect(
        Math.abs(result.apiKey.expiresAt!.getTime() - explicitExpiry.getTime()),
      ).toBeLessThan(1000);
    });

    it('no expiresAt is set when API_KEY_DEFAULT_EXPIRY_DAYS=0 (default, non-expiring)', async () => {
      // service from outer scope has defaultExpiryDays=0
      const result = await service.createApiKey({
        name: 'non-expiring-key',
        projectId: 'project-123',
      });

      expect(result.apiKey.expiresAt).toBeUndefined();
    });

    it('key created with default expiry is rejected after it expires', async () => {
      // Create a key with a very short explicit expiry (already in the past)
      const result = await serviceWithExpiry.createApiKey({
        name: 'already-expired-default',
        projectId: 'project-expiry',
        expiresAt: new Date(Date.now() - 1), // already expired
      });

      // validateApiKey should throw UnauthorizedException
      await expect(
        serviceWithExpiry.validateApiKey(result.plainTextKey),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('validateApiKey marks the key as EXPIRED in the DB when expiry has passed', async () => {
      const result = await serviceWithExpiry.createApiKey({
        name: 'mark-expired-key',
        projectId: 'project-expiry',
        expiresAt: new Date(Date.now() - 1),
      });

      try {
        await serviceWithExpiry.validateApiKey(result.plainTextKey);
      } catch {
        // expected 401
      }

      // The update call should have set status = EXPIRED
      const updateCall = prismaWithExpiry.apiKey.update.mock.calls.find(
        (call: any[]) => call[0]?.data?.status === ApiKeyStatus.EXPIRED,
      );
      expect(updateCall).toBeDefined();
    });
  });
});
