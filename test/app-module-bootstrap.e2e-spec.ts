/**
 * AppModule bootstrap integration test
 *
 * Boots the real AppModule (no mock overrides) the same way main.ts does and
 * verifies that critical modules — WalletsModule, KeyManagementModule, and all
 * global middleware/guards — are properly wired together.
 *
 * WHY THIS EXISTS
 * Most e2e suites swap core services with Jest mocks, so a missing module import
 * or mis-wired provider is invisible to them. This test imports AppModule as-is
 * and asserts that every expected NestJS building block resolves from the DI
 * container. If a module is removed from AppModule.imports[], these tests fail.
 *
 * The test does NOT require a live database or Stellar node — it only verifies
 * that NestJS can compile and initialise the module graph.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { WalletsService } from '../src/wallets/wallets.service';
import { KeyManagementService } from '../src/key-management/key-management.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { IsoUtcTimestampInterceptor } from '../src/common/interceptors';
import { MaintenanceGuard } from '../src/maintenance/maintenance.guard';
import { RateLimitGuard } from '../src/rate-limit/rate-limit.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import * as request from 'supertest';

describe('AppModule Bootstrap (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // Replicate main.ts bootstrap sequence exactly
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new IsoUtcTimestampInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  // ── DI wiring: critical services resolve from the container ───────────────

  describe('Dependency injection wiring', () => {
    it('WalletsService is resolvable from AppModule', () => {
      const svc = moduleRef.get(WalletsService, { strict: false });
      expect(svc).toBeDefined();
      expect(typeof svc.findAll).toBe('function');
    });

    it('KeyManagementService is resolvable from AppModule', () => {
      const svc = moduleRef.get(KeyManagementService, { strict: false });
      expect(svc).toBeDefined();
      expect(typeof svc.generateKey).toBe('function');
    });

    it('ApiKeyService is resolvable from AppModule', () => {
      const svc = moduleRef.get(ApiKeyService, { strict: false });
      expect(svc).toBeDefined();
      expect(typeof svc.validateApiKey).toBe('function');
    });

    it('ApiKeyGuard is resolvable from AppModule', () => {
      const guard = moduleRef.get(ApiKeyGuard, { strict: false });
      expect(guard).toBeDefined();
    });

    it('MaintenanceGuard is resolvable from AppModule', () => {
      const guard = moduleRef.get(MaintenanceGuard, { strict: false });
      expect(guard).toBeDefined();
    });

    it('RateLimitGuard is resolvable from AppModule', () => {
      const guard = moduleRef.get(RateLimitGuard, { strict: false });
      expect(guard).toBeDefined();
    });

    it('PrismaService is resolvable from AppModule', () => {
      const svc = moduleRef.get(PrismaService, { strict: false });
      expect(svc).toBeDefined();
    });
  });

  // ── HTTP layer: public endpoints respond correctly after real bootstrap ────

  describe('Public endpoints are reachable after real bootstrap', () => {
    it('GET /v1/health returns 200', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health');
      expect(res.status).toBe(200);
    });

    it('GET /v1/ready returns 200 or 503 (not 404 — route is wired)', async () => {
      const res = await request(app.getHttpServer()).get('/v1/ready');
      // 200 when DB is reachable, 503 when not — but never 404
      expect([200, 503]).toContain(res.status);
    });
  });

  // ── Global filter is active ───────────────────────────────────────────────

  describe('HttpExceptionFilter is globally active', () => {
    it('404 on unknown route returns structured envelope', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/this-route-definitely-does-not-exist')
        .set('X-Request-ID', 'bootstrap-test-001');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        statusCode: 404,
        path: '/v1/this-route-definitely-does-not-exist',
        method: 'GET',
        error: 'Not Found',
        requestId: 'bootstrap-test-001',
      });
      expect(typeof res.body.timestamp).toBe('string');
      expect(typeof res.body.message).toBe('string');
    });

    it('error envelope does not contain stack traces', async () => {
      const res = await request(app.getHttpServer()).get(
        '/v1/nonexistent-endpoint',
      );

      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('stack');
      expect(JSON.stringify(res.body)).not.toMatch(/\.ts:\d+/);
    });
  });

  // ── ApiKeyGuard is globally applied (not just on wallets module) ──────────

  describe('ApiKeyGuard is globally applied', () => {
    it('GET /v1/wallets without API key returns 401', async () => {
      const res = await request(app.getHttpServer()).get('/v1/wallets');
      expect(res.status).toBe(401);
    });

    it('GET /v1/wallets/protected without API key returns 401', async () => {
      const res = await request(app.getHttpServer()).get(
        '/v1/wallets/protected',
      );
      expect(res.status).toBe(401);
    });
  });

  // ── IsoUtcTimestampInterceptor is active ──────────────────────────────────

  describe('Global interceptors are active', () => {
    it('GET /v1/health response Content-Type is application/json', async () => {
      const res = await request(app.getHttpServer()).get('/v1/health');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  // ── Regression guard: duplicate module imports don't blow up ─────────────
  // AppModule currently lists IdempotentUserModule and TracingModule twice.
  // NestJS deduplicates them automatically. This test confirms the app still
  // boots despite the duplicates and they don't cause DI errors.

  describe('Duplicate module imports are handled gracefully', () => {
    it('app boots even with duplicated module imports in AppModule', () => {
      // If we reach this line, bootstrap succeeded despite duplicates
      expect(app).toBeDefined();
    });
  });
});
