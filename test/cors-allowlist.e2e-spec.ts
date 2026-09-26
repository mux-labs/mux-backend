/**
 * E2E tests for the CORS allowlist policy and its dashboard ([#934]).
 *
 * Covers what only shows up over real HTTP:
 *  - a browser request from an allowlisted origin receives
 *    `Access-Control-Allow-Origin` + `Vary: Origin`
 *  - any other origin receives no ACAO header at all
 *  - subdomain / suffix lookalikes are refused
 *  - the allowlist dashboard is deny-by-default (401 without an API key)
 *
 * The dashboard is mounted with the real `ApiKeyGuard` and a stubbed
 * `ApiKeyService`, so no database is required.
 */
import { Test } from '@nestjs/testing';
import {
  Controller,
  Get,
  INestApplication,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { buildCorsOptions } from '../src/common/http/cors';
import { CorsAllowlistController } from '../src/common/http/cors-dashboard.controller';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { ApiKeyService } from '../src/api-keys/api-key.service';

const VALID_API_KEY = 'mux_test_corse2ekey12345678901234567890';
const ALLOWLIST = ['https://app.mux.finance'];

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

function makeApiKeyService(): Partial<ApiKeyService> {
  return {
    // Mirror the real service: an unknown key throws UnauthorizedException
    // (returning null would make the guard dereference a null context).
    validateApiKey: jest.fn((key: string) => {
      if (key !== VALID_API_KEY) {
        return Promise.reject(new UnauthorizedException('Invalid API key'));
      }
      return Promise.resolve({
        apiKey: { id: 'api-key-id' },
        project: { id: 'proj-id', name: 'proj-name', rateLimitRpm: 1000 },
        developer: { id: 'dev-id', email: 'dev@example.com' },
      } as never);
    }),
    recordUsage: jest.fn(),
  };
}

describe('CORS allowlist over HTTP (e2e, #934)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableCors(buildCorsOptions(ALLOWLIST));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns Access-Control-Allow-Origin for an allowlisted origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://app.mux.finance')
      .expect(200);

    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.mux.finance',
    );
  });

  it('sets Vary: Origin so caches cannot cross-serve origins', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://app.mux.finance')
      .expect(200);

    expect(res.headers['vary']).toContain('Origin');
  });

  it('sends no ACAO header to a non-allowlisted origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://evil.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a subdomain lookalike of an allowlisted origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://evil.app.mux.finance');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a prefix lookalike of an allowlisted origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://app.mux.finance.evil.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://app.mux.finance')
      .expect(200);

    // `*` alongside credentials:true would hand every origin access.
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('still serves non-browser callers that send no Origin', async () => {
    // CORS is browser-enforced; it must not become an auth layer for curl or
    // server-to-server clients.
    await request(app.getHttpServer()).get('/probe/ok').expect(200);
  });

  it('answers a preflight from an allowlisted origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/probe/ok')
      .set('Origin', 'https://app.mux.finance')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.mux.finance',
    );
  });
});

describe('CORS allowlist dashboard over HTTP (e2e, #934)', () => {
  let app: INestApplication;

  async function buildDashboard(corsOrigins?: string) {
    const moduleRef = await Test.createTestingModule({
      controllers: [CorsAllowlistController],
      providers: [
        ApiKeyGuard,
        { provide: ApiKeyService, useValue: makeApiKeyService() },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'CORS_ORIGINS' ? corsOrigins : undefined,
          },
        },
      ],
    }).compile();

    const localApp = moduleRef.createNestApplication();
    localApp.setGlobalPrefix('v1');
    localApp.useGlobalGuards(
      new ApiKeyGuard(moduleRef.get(ApiKeyService), moduleRef.get(Reflector)),
    );
    await localApp.init();
    return localApp;
  }

  afterEach(async () => {
    await app?.close();
  });

  it('requires an API key (deny-by-default)', async () => {
    app = await buildDashboard('https://app.mux.finance');

    await request(app.getHttpServer())
      .get('/v1/internal/cors-allowlist')
      .expect(401);
  });

  it('rejects a revoked/invalid API key', async () => {
    app = await buildDashboard('https://app.mux.finance');

    await request(app.getHttpServer())
      .get('/v1/internal/cors-allowlist')
      .set('Authorization', 'Bearer mux_revoked_key')
      .expect(401);
  });

  it('returns the effective allowlist to an authorized caller', async () => {
    app = await buildDashboard(
      'https://app.mux.finance,https://partner.example.com',
    );

    const res = await request(app.getHttpServer())
      .get('/v1/internal/cors-allowlist')
      .set('Authorization', `Bearer ${VALID_API_KEY}`)
      .expect(200);

    expect(res.body).toMatchObject({
      origins: ['https://app.mux.finance', 'https://partner.example.com'],
      usingDefault: false,
    });
  });

  it('surfaces a rejected wildcard so the operator can see why an origin is blocked', async () => {
    app = await buildDashboard('https://app.mux.finance,*');

    const res = await request(app.getHttpServer())
      .get('/v1/internal/cors-allowlist')
      .set('Authorization', `Bearer ${VALID_API_KEY}`)
      .expect(200);

    expect(res.body).toMatchObject({
      rejected: [
        {
          entry: '*',
          reason: 'wildcard origins are not allowed with credentials enabled',
        },
      ],
    });
  });

  it('flags the localhost default when CORS_ORIGINS is unset', async () => {
    app = await buildDashboard(undefined);

    const res = await request(app.getHttpServer())
      .get('/v1/internal/cors-allowlist')
      .set('Authorization', `Bearer ${VALID_API_KEY}`)
      .expect(200);

    expect(res.body).toMatchObject({ usingDefault: true, origins: [] });
  });

  it('never reflects a non-origin config value back to the caller', async () => {
    app = await buildDashboard('WALLET_ENCRYPTION_KEY');

    const res = await request(app.getHttpServer())
      .get('/v1/internal/cors-allowlist')
      .set('Authorization', `Bearer ${VALID_API_KEY}`)
      .expect(200);

    expect(res.body).toMatchObject({
      origins: [],
      rejected: [
        { entry: 'WALLET_ENCRYPTION_KEY', reason: 'not an http(s) origin' },
      ],
    });
  });

  it('is read-only — no way to mutate the allowlist over the API', async () => {
    app = await buildDashboard('https://app.mux.finance');

    await request(app.getHttpServer())
      .post('/v1/internal/cors-allowlist')
      .set('Authorization', `Bearer ${VALID_API_KEY}`)
      .send({ origins: ['https://evil.com'] })
      .expect(404);
  });
});
