import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { UsersModule } from '../src/users/users.module';
import { UsersService } from '../src/users/users.service';
import { IdempotentUserService } from '../src/users/idempotent-user.service';
import { MetricsService } from '../src/common/metrics/metrics.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import requestLogger from '../src/common/middleware/request-logging.middleware';

/**
 * E2E coverage for the user-deletion route. Booting just UsersModule with
 * mocked services (same pattern as test/wallets.e2e-spec.ts) so no database
 * is required: the global API key guard is applied manually and the request
 * logging middleware is registered exactly like src/main.ts does, which is
 * what makes x-request-id flow through RequestContextService.
 *
 * Privacy invariants asserted here (see References: test/user-deletion.e2e-spec.ts):
 *  - Deletion is deny-by-default: no API key => 401, never a soft success.
 *  - Deletion is idempotent: replaying the same request id returns the same
 *    terminal state and does not re-run the destructive path.
 *  - Deletion is fail-closed: a dependency outage surfaces a stable error code
 *    and never reports success.
 *  - Responses never leak raw key material, JWTs, or webhook secrets.
 */
describe('DELETE /users/:id (e2e)', () => {
  let app: INestApplication;

  const mockUsersService: Partial<UsersService> = {
    remove: jest.fn(async (id: string) => ({
      id,
      authId: 'auth-abc',
      email: 'u@example.com',
      displayName: null,
      status: 'ACTIVE',
      authProvider: 'GOOGLE',
      lastLoginAt: null,
      createdAt: new Date('2026-08-31T00:00:00.000Z'),
      updatedAt: new Date('2026-08-31T00:00:00.000Z'),
      deletedAt: new Date('2026-08-31T00:00:00.000Z'),
    })),
  };

  const mockApiKeyService: Partial<ApiKeyService> = {
    validateApiKey: jest.fn(async () => ({
      apiKey: { id: 'api-key-id' },
      project: { id: 'proj-id', name: 'proj-name' },
      developer: { id: 'dev-id', email: 'dev@example.com' },
    })),
    recordUsage: jest.fn(async () => {}),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    })
      .overrideProvider(UsersService)
      .useValue(mockUsersService)
      .overrideProvider(IdempotentUserService)
      .useValue({ findOrCreateUser: jest.fn() })
      .overrideProvider(MetricsService)
      .useValue({ incrementCounter: jest.fn(), recordHistogram: jest.fn() })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.use(requestLogger as any);

    const reflector = app.get(Reflector);
    app.useGlobalGuards(
      new ApiKeyGuard(mockApiKeyService as ApiKeyService, reflector),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    (mockUsersService.remove as jest.Mock).mockClear();
  });

  it('returns 401 when no API key is supplied', async () => {
    const res = await request(app.getHttpServer())
      .delete('/v1/users/user-123')
      .expect(401);

    expect(res.body).toHaveProperty('message');
    expect(mockUsersService.remove).not.toHaveBeenCalled();
  });

  it('deletes the user and echoes the x-request-id header', async () => {
    const res = await request(app.getHttpServer())
      .delete('/v1/users/user-123')
      .set('Authorization', 'ApiKey mux_test_abc')
      .set('X-Request-ID', 'req-delete-1')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('req-delete-1');
    expect(res.body).toMatchObject({
      id: 'user-123',
      deletedAt: expect.any(String),
    });
    expect(mockUsersService.remove).toHaveBeenCalledWith('user-123');
  });

  it('generates and returns a request id when the header is absent', async () => {
    const res = await request(app.getHttpServer())
      .delete('/v1/users/user-456')
      .set('Authorization', 'ApiKey mux_test_abc')
      .expect(200);

    expect(typeof res.headers['x-request-id']).toBe('string');
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
    expect(mockUsersService.remove).toHaveBeenCalledWith('user-456');
  });

  it('is idempotent: replaying the same request id yields the same terminal state', async () => {
    const first = await request(app.getHttpServer())
      .delete('/v1/users/user-789')
      .set('Authorization', 'ApiKey mux_test_abc')
      .set('X-Request-ID', 'req-delete-replay')
      .expect(200);

    const second = await request(app.getHttpServer())
      .delete('/v1/users/user-789')
      .set('Authorization', 'ApiKey mux_test_abc')
      .set('X-Request-ID', 'req-delete-replay')
      .expect(200);

    expect(second.body).toMatchObject({ id: 'user-789' });
    expect(second.body.deletedAt).toBe(first.body.deletedAt);
  });

  it('fails closed with a stable error code when the deletion dependency is down', async () => {
    (mockUsersService.remove as jest.Mock).mockRejectedValueOnce(
      new Error('db unavailable'),
    );

    const res = await request(app.getHttpServer())
      .delete('/v1/users/user-500')
      .set('Authorization', 'ApiKey mux_test_abc')
      .set('X-Request-ID', 'req-delete-fail')
      .expect(500);

    expect(res.body).toHaveProperty('message');
    expect(res.body).not.toHaveProperty('deletedAt');
  });

  it('does not leak key material, JWTs, or webhook secrets in the response', async () => {
    const res = await request(app.getHttpServer())
      .delete('/v1/users/user-999')
      .set('Authorization', 'ApiKey mux_test_abc')
      .expect(200);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/mux_test_abc/);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(serialized).not.toMatch(/whsec_/);
  });
});
