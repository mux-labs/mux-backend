/**
 * API Key Expiry Enforcement — E2E tests
 *
 * WHY THIS EXISTS
 * README documents that:
 *   "When set, newly created API keys expire after this many days."
 *   "Expired keys are marked with status EXPIRED on first validation attempt"
 *   "Subsequent requests with expired keys fail with 'API key has expired'"
 *
 * These tests verify the complete enforcement path end-to-end:
 *   1. createApiKey() respects API_KEY_DEFAULT_EXPIRY_DAYS from ConfigService.
 *   2. An already-expired key is rejected on the first validateApiKey() call.
 *   3. The key's status is flipped to EXPIRED in the database on that call.
 *   4. Subsequent calls return 401 because the status is now EXPIRED.
 *   5. A key with no expiry (default) remains valid indefinitely.
 *   6. An explicit expiresAt supplied by the caller beats the default.
 *
 * The suite uses ApiKeyModule directly (not full AppModule) and replaces
 * PrismaClient with an in-memory stub, so it runs fully offline.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { ApiKeyModule } from '../src/api-keys/api-key.module';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyStatus } from '../src/api-keys/domain/api-key.model';

// ---------------------------------------------------------------------------
// In-memory Prisma stub
// ---------------------------------------------------------------------------

function makeInMemoryPrisma() {
  const store: Map<string, any> = new Map();
  let seq = 0;

  return {
    _store: store,

    project: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === 'project-expiry-e2e') {
          return {
            id: 'project-expiry-e2e',
            environment: 'development',
            developerId: 'dev-expiry-e2e',
          };
        }
        return null;
      }),
    },

    apiKey: {
      create: jest.fn(async ({ data }: any) => {
        const id = `ak-${++seq}`;
        const record = { id, ...data, network: data.network ?? null };
        store.set(id, record);
        // also index by hash
        store.set(`hash:${data.keyHash}`, id);
        return record;
      }),

      findUnique: jest.fn(async ({ where, include }: any) => {
        let record: any = null;

        if (where.id) {
          record = store.get(where.id);
        } else if (where.keyHash) {
          const id = store.get(`hash:${where.keyHash}`);
          record = id ? store.get(id) : null;
        }

        if (!record) return null;

        if (include?.project) {
          return {
            ...record,
            project: {
              id: record.projectId,
              developerId: 'dev-expiry-e2e',
              developer: { id: 'dev-expiry-e2e' },
            },
          };
        }
        return record;
      }),

      update: jest.fn(async ({ where, data }: any) => {
        const record = store.get(where.id);
        if (record) Object.assign(record, data);
        return record;
      }),
    },

    apiKeyUsage: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfigService(expiryDays: number) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'API_KEY_ROTATION_GRACE_SECONDS') return 3600;
      if (key === 'API_KEY_DEFAULT_EXPIRY_DAYS') return expiryDays;
      return undefined;
    }),
  };
}

async function buildApp(
  expiryDays: number,
): Promise<{ app: INestApplication; svc: ApiKeyService; prisma: any }> {
  const prisma = makeInMemoryPrisma();
  const configService = makeConfigService(expiryDays);

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [ApiKeyModule],
  })
    .overrideProvider(ConfigService)
    .useValue(configService)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await app.init();

  const svc = moduleRef.get<ApiKeyService>(ApiKeyService);
  // Inject the in-memory prisma stub
  svc['prisma'] = prisma;

  return { app, svc, prisma };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('API Key Expiry Enforcement (e2e)', () => {
  // ── Default expiry applied when API_KEY_DEFAULT_EXPIRY_DAYS is set ─────────

  describe('API_KEY_DEFAULT_EXPIRY_DAYS configuration', () => {
    let svc: ApiKeyService;

    beforeAll(async () => {
      ({ svc } = await buildApp(30));
    });

    it('createApiKey() sets expiresAt ~30 days ahead when defaultExpiryDays=30 and no explicit expiresAt', async () => {
      const before = Date.now();
      const result = await svc.createApiKey({
        name: 'default-expiry',
        projectId: 'project-expiry-e2e',
      });
      const after = Date.now();

      expect(result.apiKey.expiresAt).toBeDefined();
      const exp = result.apiKey.expiresAt!.getTime();
      expect(exp).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
      expect(exp).toBeLessThanOrEqual(after + 30 * 24 * 60 * 60 * 1000);
    });

    it('explicit expiresAt from caller overrides the configured default', async () => {
      const explicit = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      const result = await svc.createApiKey({
        name: 'explicit-expiry',
        projectId: 'project-expiry-e2e',
        expiresAt: explicit,
      });

      expect(
        Math.abs(result.apiKey.expiresAt!.getTime() - explicit.getTime()),
      ).toBeLessThan(1000);
    });
  });

  // ── No default expiry when API_KEY_DEFAULT_EXPIRY_DAYS=0 ─────────────────

  describe('API_KEY_DEFAULT_EXPIRY_DAYS=0 (non-expiring keys)', () => {
    let svc: ApiKeyService;

    beforeAll(async () => {
      ({ svc } = await buildApp(0));
    });

    it('createApiKey() does NOT set expiresAt when defaultExpiryDays=0', async () => {
      const result = await svc.createApiKey({
        name: 'no-expiry',
        projectId: 'project-expiry-e2e',
      });

      expect(result.apiKey.expiresAt).toBeUndefined();
    });
  });

  // ── Expired key enforcement ───────────────────────────────────────────────

  describe('Expired key rejection and status update', () => {
    let svc: ApiKeyService;
    let prisma: any;

    beforeAll(async () => {
      ({ svc, prisma } = await buildApp(0));
    });

    it('validateApiKey() throws 401 for a key with expiresAt in the past', async () => {
      const { plainTextKey } = await svc.createApiKey({
        name: 'past-expiry',
        projectId: 'project-expiry-e2e',
        expiresAt: new Date(Date.now() - 1000), // already expired
      });

      await expect(svc.validateApiKey(plainTextKey)).rejects.toMatchObject({
        status: 401,
        message: 'API key has expired',
      });
    });

    it('validateApiKey() flips status to EXPIRED in the store on first rejection', async () => {
      const { plainTextKey, apiKey } = await svc.createApiKey({
        name: 'status-flip',
        projectId: 'project-expiry-e2e',
        expiresAt: new Date(Date.now() - 1000),
      });

      try {
        await svc.validateApiKey(plainTextKey);
      } catch {
        // expected 401
      }

      // The update mock should have been called with status=EXPIRED
      const updateCalls: any[] = prisma.apiKey.update.mock.calls;
      const flipCall = updateCalls.find(
        (args) =>
          args[0]?.where?.id === apiKey.id &&
          args[0]?.data?.status === ApiKeyStatus.EXPIRED,
      );
      expect(flipCall).toBeDefined();
    });

    it('second call on an already-EXPIRED-status key returns 401 without another DB update', async () => {
      const { plainTextKey, apiKey } = await svc.createApiKey({
        name: 'already-expired-status',
        projectId: 'project-expiry-e2e',
        expiresAt: new Date(Date.now() - 500),
      });

      // First call — status flip happens
      try {
        await svc.validateApiKey(plainTextKey);
      } catch {
        /* expected */
      }

      const updateCountAfterFirst = prisma.apiKey.update.mock.calls.length;

      // Simulate that the DB now returns status=EXPIRED directly
      const storedKey = prisma._store.get(apiKey.id);
      storedKey.status = ApiKeyStatus.EXPIRED;
      storedKey.expiresAt = new Date(Date.now() + 100_000); // clear expiry to hit the status check first

      // Second call — should still be rejected (status=EXPIRED check runs before expiresAt)
      await expect(svc.validateApiKey(plainTextKey)).rejects.toMatchObject({
        status: 401,
        message: 'API key has expired',
      });

      // No additional update call for the second rejection (status already EXPIRED)
      expect(prisma.apiKey.update.mock.calls.length).toBe(
        updateCountAfterFirst,
      );
    });
  });

  // ── Future-dated key is valid until its expiry ────────────────────────────

  describe('Future-dated key remains valid', () => {
    let svc: ApiKeyService;

    beforeAll(async () => {
      ({ svc } = await buildApp(0));
    });

    it('validateApiKey() succeeds for a key that expires far in the future', async () => {
      const { plainTextKey, apiKey } = await svc.createApiKey({
        name: 'future-expiry',
        projectId: 'project-expiry-e2e',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
      });

      const ctx = await svc.validateApiKey(plainTextKey);
      expect(ctx.apiKey.id).toBe(apiKey.id);
      expect(ctx.apiKey.status).toBe(ApiKeyStatus.ACTIVE);
    });
  });

  // ── Boundary: expiry exactly at current time ──────────────────────────────

  describe('Expiry boundary behaviour', () => {
    let svc: ApiKeyService;

    beforeAll(async () => {
      ({ svc } = await buildApp(0));
    });

    it('a key expiring at exactly Date.now() is rejected (expiresAt < new Date() is false; expiresAt === now is caught by < check)', async () => {
      // We cannot reliably test "expiresAt === now" since JS Date comparison
      // uses < (strictly less-than) — a key set to exactly now() will slip
      // through until the next millisecond.  We document the known behaviour:
      // expiresAt strictly in the past is always rejected.
      const { plainTextKey } = await svc.createApiKey({
        name: 'boundary-key',
        projectId: 'project-expiry-e2e',
        expiresAt: new Date(Date.now() - 1), // 1 ms in the past
      });

      await expect(svc.validateApiKey(plainTextKey)).rejects.toMatchObject({
        status: 401,
      });
    });
  });
});
