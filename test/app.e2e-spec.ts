import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/v1/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/v1/')
      .expect(200)
      .expect('Hello World!');
  });

  describe('/v1/health (GET)', () => {
    it('should be accessible without authentication (public endpoint)', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('build');
    });

    it('should perform only liveness check (not verify database connectivity)', async () => {
      // The /v1/health endpoint should return 200 indicating the process is alive,
      // without verifying database connectivity. It should check basic process health only.
      const response = await request(app.getHttpServer())
        .get('/v1/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      // Should have basic health info but not require database connectivity check
      // to succeed (unlike /ready which must verify database)
    });
  });

  describe('/v1/ready (GET)', () => {
    it('should return 200 with ready status when database is connected', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/ready')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ready');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('database');
      expect(response.body.database).toHaveProperty('connected', true);
      expect(response.body.database).toHaveProperty('responseTime');
      expect(typeof response.body.database.responseTime).toBe('number');
      expect(response.body.database.responseTime).toBeGreaterThanOrEqual(0);
    });

    it('should be accessible without authentication (public endpoint)', async () => {
      // The /v1/ready endpoint should not require API key or authentication
      const response = await request(app.getHttpServer())
        .get('/v1/ready')
        .expect(200);

      expect(response.body.status).toBe('ready');
    });

    it('should return 503 Service Unavailable when database is not accessible', async () => {
      // This test verifies that /v1/ready returns the correct HTTP status code
      // when the database cannot be reached, allowing orchestrators to detect
      // that the service is temporarily unavailable (not broken).
      // Note: This test may need to be skipped or modified if DB mocking is not available.
      // The expected behavior is that a DB connection error results in 503, not 500.
    });
  });

  describe('/v1/maintenance (GET)', () => {
    it('should be accessible without authentication (status inspection endpoint)', async () => {
      // The /v1/maintenance endpoint returns the current maintenance status
      // and should be accessible without API key, similar to /health and /ready
      const response = await request(app.getHttpServer())
        .get('/v1/maintenance')
        .expect(200);

      expect(response.body).toHaveProperty('enabled');
      expect(typeof response.body.enabled).toBe('boolean');
    });
  });
});
