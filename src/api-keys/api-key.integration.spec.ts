/**
 * API Key Management — integration tests
 *
 * Uses a mock PrismaClient to exercise the full ApiKeyService lifecycle:
 * create → validate → list → rotate → revoke.
 * The mock stores keys in memory so calls cross-reference correctly.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from './api-key.service';
import { ApiKeyStatus } from './domain/api-key.model';

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    project: { findUnique: jest.fn() },
    apiKey: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    apiKeyUsage: { create: jest.fn() },
  })),
}));

describe('ApiKeyService (integration)', () => {
  let service: ApiKeyService;
  let mockPrisma: any;
  const storedKeys: any[] = [];

  const project = {
    id: 'project-integration-1',
    environment: 'production',
    developerId: 'dev-integration-1',
  };

  beforeEach(async () => {
    storedKeys.length = 0;

    mockPrisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue(project),
      },
      apiKey: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          const key = {
            id: `key-${storedKeys.length + 1}`,
            name: data.name,
            keyHash: data.keyHash,
            keyPrefix: data.keyPrefix,
            lastFour: data.lastFour,
            projectId: data.projectId,
            status: data.status,
            expiresAt: data.expiresAt ?? null,
            gracePeriodEndsAt: null,
            lastUsedAt: null,
            revokedAt: null,
            revokedReason: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          storedKeys.push(key);
          return key;
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          if (where?.id) {
            return storedKeys.find((k) => k.id === where.id) ?? null;
          }
          if (where?.keyHash) {
            const found = storedKeys.find((k) => k.keyHash === where.keyHash);
            if (!found) return null;
            return {
              ...found,
              project: { ...project, developer: { id: project.developerId } },
            };
          }
          return null;
        }),
        findMany: jest.fn().mockImplementation(async ({ where, skip = 0, take }) => {
          const all = storedKeys.filter((k) => k.projectId === where.projectId);
          return all.slice(skip, take ? skip + take : undefined);
        }),
        count: jest.fn().mockImplementation(async ({ where }) =>
          storedKeys.filter((k) => k.projectId === where.projectId).length,
        ),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const key = storedKeys.find((k) => k.id === where.id);
          if (!key) throw new Error('Not found');
          Object.assign(key, data);
          return key;
        }),
      },
      apiKeyUsage: { create: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'API_KEY_ROTATION_GRACE_SECONDS' ? 3600 : undefined,
          },
        },
      ],
    }).compile();

    service = module.get<ApiKeyService>(ApiKeyService);
    service['prisma'] = mockPrisma;
  });

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  describe('createApiKey', () => {
    it('returns a mux_live_ prefixed key for a production project', async () => {
      const { plainTextKey } = await service.createApiKey({
        name: 'prod-key',
        projectId: project.id,
      });
      expect(plainTextKey).toMatch(/^mux_live_/);
    });

    it('stores a SHA-256 hash, never the plain-text key', async () => {
      const { apiKey, plainTextKey } = await service.createApiKey({
        name: 'hash-check',
        projectId: project.id,
      });
      expect(apiKey.keyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(apiKey.keyHash).not.toBe(plainTextKey);
    });

    it('sets status ACTIVE on creation', async () => {
      const { apiKey } = await service.createApiKey({
        name: 'active-check',
        projectId: project.id,
      });
      expect(apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });

    it('respects an explicit expiresAt date', async () => {
      const expiresAt = new Date(Date.now() + 86_400_000); // +1 day
      const { apiKey } = await service.createApiKey({
        name: 'expiring',
        projectId: project.id,
        expiresAt,
      });
      expect(apiKey.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    });

    it('throws when the project does not exist', async () => {
      mockPrisma.project.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.createApiKey({ name: 'ghost', projectId: 'nonexistent' }),
      ).rejects.toThrow('not found');
    });
  });

  // ---------------------------------------------------------------------------
  // Validate
  // ---------------------------------------------------------------------------

  describe('validateApiKey', () => {
    it('rejects keys that do not start with mux_', async () => {
      await expect(service.validateApiKey('sk_bad_key')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a key that is not in the store', async () => {
      await expect(
        service.validateApiKey('mux_live_doesnotexist'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('successfully validates a freshly created key', async () => {
      const { plainTextKey } = await service.createApiKey({
        name: 'validate-me',
        projectId: project.id,
      });
      const ctx = await service.validateApiKey(plainTextKey);
      expect(ctx.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
      expect(ctx.project.id).toBe(project.id);
    });

    it('rejects a key that has already been revoked', async () => {
      const { apiKey, plainTextKey } = await service.createApiKey({
        name: 'to-revoke',
        projectId: project.id,
      });
      await service.revokeApiKey(apiKey.id);
      await expect(service.validateApiKey(plainTextKey)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a key that has passed its expiresAt', async () => {
      const { apiKey, plainTextKey } = await service.createApiKey({
        name: 'past-expiry',
        projectId: project.id,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.validateApiKey(plainTextKey)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  describe('listApiKeys', () => {
    it('returns all keys created for the project', async () => {
      await service.createApiKey({ name: 'k1', projectId: project.id });
      await service.createApiKey({ name: 'k2', projectId: project.id });
      const { keys, total } = await service.listApiKeys({
        projectId: project.id,
      });
      expect(total).toBe(2);
      expect(keys).toHaveLength(2);
    });

    it('paginates results correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await service.createApiKey({ name: `key-${i}`, projectId: project.id });
      }
      const { keys, total, page, pageSize } = await service.listApiKeys({
        projectId: project.id,
        page: 1,
        pageSize: 3,
      });
      expect(total).toBe(5);
      expect(keys).toHaveLength(3);
      expect(page).toBe(1);
      expect(pageSize).toBe(3);
    });

    it('never exposes keyHash or plain-text key in list results', async () => {
      await service.createApiKey({ name: 'safe-list', projectId: project.id });
      const { keys } = await service.listApiKeys({ projectId: project.id });
      keys.forEach((k) => {
        expect((k as any).keyHash).toBeUndefined();
        expect((k as any).plainTextKey).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Rotate
  // ---------------------------------------------------------------------------

  describe('rotateApiKey', () => {
    it('creates a new key and both keys are initially valid', async () => {
      const { apiKey: old, plainTextKey: oldPlain } = await service.createApiKey({
        name: 'rotate-me',
        projectId: project.id,
      });

      const { apiKey: next, plainTextKey: nextPlain } =
        await service.rotateApiKey({ apiKeyId: old.id });

      expect(nextPlain).not.toBe(oldPlain);
      const oldCtx = await service.validateApiKey(oldPlain);
      const newCtx = await service.validateApiKey(nextPlain);
      expect(oldCtx.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
      expect(newCtx.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });

    it('sets gracePeriodEndsAt on the old key', async () => {
      const { apiKey } = await service.createApiKey({
        name: 'grace-check',
        projectId: project.id,
      });
      await service.rotateApiKey({ apiKeyId: apiKey.id });
      const storedOld = storedKeys.find((k) => k.id === apiKey.id);
      expect(storedOld.gracePeriodEndsAt).toBeDefined();
      expect(storedOld.gracePeriodEndsAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('optionally accepts a new name for the rotated key', async () => {
      const { apiKey } = await service.createApiKey({
        name: 'old-name',
        projectId: project.id,
      });
      const { apiKey: rotated } = await service.rotateApiKey({
        apiKeyId: apiKey.id,
        name: 'new-name',
      });
      expect(rotated.name).toBe('new-name');
    });
  });

  // ---------------------------------------------------------------------------
  // Revoke
  // ---------------------------------------------------------------------------

  describe('revokeApiKey', () => {
    it('marks the key as REVOKED', async () => {
      const { apiKey } = await service.createApiKey({
        name: 'revoke-me',
        projectId: project.id,
      });
      const revoked = await service.revokeApiKey(apiKey.id);
      expect(revoked.status).toBe(ApiKeyStatus.REVOKED);
      expect(revoked.revokedAt).toBeDefined();
    });

    it('is idempotent — revoking an already-revoked key succeeds', async () => {
      const { apiKey } = await service.createApiKey({
        name: 'double-revoke',
        projectId: project.id,
      });
      await service.revokeApiKey(apiKey.id);
      const second = await service.revokeApiKey(apiKey.id);
      expect(second.status).toBe(ApiKeyStatus.REVOKED);
    });

    it('stores the revocation reason', async () => {
      const { apiKey } = await service.createApiKey({
        name: 'reason-key',
        projectId: project.id,
      });
      const revoked = await service.revokeApiKey(
        apiKey.id,
        'Security incident',
      );
      expect(revoked.revokedReason).toBe('Security incident');
    });

    it('throws when developer does not own the key', async () => {
      const { apiKey } = await service.createApiKey({
        name: 'ownership-check',
        projectId: project.id,
      });
      const storedKey = storedKeys.find((k) => k.id === apiKey.id);
      mockPrisma.apiKey.findUnique.mockResolvedValueOnce({
        ...storedKey,
        project: { ...project, developerId: 'other-dev' },
      });
      await expect(
        service.revokeApiKey(apiKey.id, undefined, 'attacker-dev'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
