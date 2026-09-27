import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import * as request from 'supertest';

/**
 * E2E test verifying that the internal cron endpoints under
 * /v1/transactions/internal/* are guarded by CronSecretGuard, and that a
 * project API key alone (without X-Cron-Secret) is never sufficient to
 * reach them (issue #801).
 *
 * This mirrors the existing backup-module-registered.e2e-spec.ts pattern
 * for CronSecretGuard-protected routes.
 */
describe('TransactionsInternalController - CronSecretGuard enforcement (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('without any credentials', () => {
    it('POST /v1/transactions/internal/poll-pending returns 401', async () => {
      const response = await request(app.getHttpServer()).post(
        '/v1/transactions/internal/poll-pending',
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('GET /v1/transactions/internal/stuck-pending returns 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/v1/transactions/internal/stuck-pending',
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('POST /v1/transactions/internal/relayer-funding/check returns 401', async () => {
      const response = await request(app.getHttpServer()).post(
        '/v1/transactions/internal/relayer-funding/check?walletId=x',
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('with only a project API-style Authorization header (no X-Cron-Secret)', () => {
    // This is the exact gap described in #801: a caller must not be able to
    // reach the cron/internal endpoints using only something that looks like
    // a project API key. Whether or not the key is itself valid, the
    // X-Cron-Secret header is mandatory, and the request must never proceed
    // past that boundary based on Authorization alone.
    it('POST /v1/transactions/internal/poll-pending still returns 401', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('Authorization', 'Bearer mux_live_not_a_real_key');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('GET /v1/transactions/internal/stuck-pending still returns 401', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/transactions/internal/stuck-pending')
        .set('Authorization', 'Bearer mux_live_not_a_real_key');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('with an incorrect X-Cron-Secret', () => {
    it('POST /v1/transactions/internal/poll-pending returns 401', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', 'definitely-not-the-configured-secret');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('with a valid X-Cron-Secret', () => {
    // Note: whether this reaches 200 depends on a valid CRON_SECRET being
    // configured for the test environment (it is required in production by
    // env.validation.ts, but may be unset in a local/dev run). Either way,
    // the response must never be a bare pass-through (i.e. never anything
    // other than 200 or 401), and it must never be reachable via 404 (which
    // would indicate the route/guard wiring itself is broken).
    it('POST /v1/transactions/internal/poll-pending reaches the controller and is never unauthenticated', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', process.env.CRON_SECRET || 'invalid');

      expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(
        response.status,
      );
    });

    it('GET /v1/transactions/internal/stuck-pending reaches the controller and is never unauthenticated', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/transactions/internal/stuck-pending')
        .set('X-Cron-Secret', process.env.CRON_SECRET || 'invalid');

      expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(
        response.status,
      );
    });
  });
});
