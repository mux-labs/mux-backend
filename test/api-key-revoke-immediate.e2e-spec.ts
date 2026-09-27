/**
 * API key revocation takes effect immediately (#942) — E2E tests.
 *
 * The invariant: there is no cache in front of the status read, so a key that
 * is revoked between two requests is refused on the very next request.
 * Revocation must also be idempotent (a retried DELETE is not an error) and
 * must be denied to a caller that does not own the key.
 *
 * Uses `ApiKeyModule` directly with an in-memory Prisma stub, so it runs
 * fully offline like `test/api-key-expiry.e2e-spec.ts`.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiKeyModule } from '../src/api-keys/api-key.module';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyStatus } from '../src/api-keys/domain/api-key.model';

const PROJECT_ID = 'project-revoke-e2e';

/** In-memory Prisma stub, indexed by id and by key hash. */
function makeInMemoryPrisma() {
  const rows: Map<string, any> = new Map();
  let seq = 0;

  const hydrate = (record: any, include?: any) => {
    if (!record) return null;
    const wantsProject = Boolean(include?.project);
    if (!wantsProject) return record;
    return {
      ...record,
      project: {
        id: record.projectId,
        environment: 'development',
        developerId: 'dev-revoke-e2e',
        ...(include.project.include?.developer
          ? { developer: { id: 'dev-revoke-e2e', email: 'dev@example.com' } }
          : {}),
      },
    };
  };

  return {
    rows,
    project: {
      findUnique: jest.fn(({ where }: any) =>
        where.id === PROJECT_ID
          ? { id: PROJECT_ID, environment: 'development' }
          : null,
      ),
    },
    apiKey: {
      create: jest.fn(({ data }: any) => {
        const id = `ak-${++seq}`;
        const record = {
          id,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(id, record);
        rows.set(`hash:${data.keyHash}`, id);
        return record;
      }),
      findUnique: jest.fn(({ where, include }: any) => {
        let record: any;
        if (where.id) {
          record = rows.get(where.id);
        } else if (where.keyHash) {
          const id = rows.get(`hash:${where.keyHash}`);
          record = id ? rows.get(id) : undefined;
        }
        return hydrate(record ?? null, include);
      }),
      update: jest.fn(({ where, data }: any) => {
        const record = rows.get(where.id);
        if (record) Object.assign(record, data, { updatedAt: new Date() });
        return record;
      }),
    },
    apiKeyUsage: { create: jest.fn(() => Promise.resolve()) },
  };
}

async function buildApp() {
  const prisma = makeInMemoryPrisma();

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [ApiKeyModule],
  })
    .overrideProvider(ConfigService)
    .useValue({
      get: jest.fn((key: string) =>
        key === 'API_KEY_DEFAULT_EXPIRY_DAYS' ? 0 : undefined,
      ),
    })
    .compile();

  const svc = moduleRef.get<ApiKeyService>(ApiKeyService);
  svc['prisma'] = prisma;

  return { svc, prisma };
}

describe('API key revoke is immediate (#942)', () => {
  it('rejects the very next validation after revocation', async () => {
    const { svc } = await buildApp();

    const { plainTextKey, apiKey } = await svc.createApiKey({
      name: 'revoke-now',
      projectId: PROJECT_ID,
    });

    // Healthy before revocation.
    await expect(svc.validateApiKey(plainTextKey)).resolves.toMatchObject({
      apiKey: { id: apiKey.id },
    });

    await svc.revokeApiKey(apiKey.id, 'operator revoked');

    // No cache, no grace period: the next call fails.
    await expect(svc.validateApiKey(plainTextKey)).rejects.toMatchObject({
      status: 401,
      message: 'API key has been revoked',
    });
  });

  it('rejects at the status check without writing to the store', async () => {
    const { svc, prisma } = await buildApp();

    const { plainTextKey, apiKey } = await svc.createApiKey({
      name: 'revoke-status',
      projectId: PROJECT_ID,
    });
    await svc.revokeApiKey(apiKey.id);

    prisma.apiKey.update.mockClear();

    await expect(svc.validateApiKey(plainTextKey)).rejects.toMatchObject({
      status: 401,
      message: 'API key has been revoked',
    });
    // Revocation is already persisted; validation never has to mutate the row
    // for it to take effect.
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('records revokedAt and the reason', async () => {
    const { svc } = await buildApp();

    const { apiKey } = await svc.createApiKey({
      name: 'revoke-audit',
      projectId: PROJECT_ID,
    });

    const before = Date.now();
    const revoked = await svc.revokeApiKey(apiKey.id, 'key leaked');

    expect(revoked.status).toBe(ApiKeyStatus.REVOKED);
    expect(revoked.revokedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(revoked.revokedReason).toBe('key leaked');
  });

  it('is idempotent: revoking twice succeeds without a second write', async () => {
    const { svc, prisma } = await buildApp();

    const { apiKey } = await svc.createApiKey({
      name: 'revoke-idempotent',
      projectId: PROJECT_ID,
    });

    await svc.revokeApiKey(apiKey.id, 'first');
    prisma.apiKey.update.mockClear();

    const second = await svc.revokeApiKey(apiKey.id, 'retried');

    expect(second.status).toBe(ApiKeyStatus.REVOKED);
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('refuses revocation from a caller that does not own the key', async () => {
    const { svc } = await buildApp();

    const { plainTextKey, apiKey } = await svc.createApiKey({
      name: 'revoke-authz',
      projectId: PROJECT_ID,
    });

    await expect(
      svc.revokeApiKey(apiKey.id, 'attacker', 'someone-else'),
    ).rejects.toMatchObject({ status: 403 });

    // A denied revocation must not have revoked anything.
    await expect(svc.validateApiKey(plainTextKey)).resolves.toMatchObject({
      apiKey: { id: apiKey.id },
    });
  });

  it('404s an unknown key id', async () => {
    const { svc } = await buildApp();

    await expect(svc.revokeApiKey('ak-missing')).rejects.toMatchObject({
      status: 404,
    });
  });
});
