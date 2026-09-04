import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import * as request from 'supertest';

/**
 * E2E test verifying that /v1/backup/* routes are reachable
 * and properly guarded with CronSecretGuard after BackupModule import.
 */
describe('BackupModule Import - Routes Reachable and Guarded (E2E)', () => {
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

  describe('CronSecretGuard enforcement', () => {
    it('should return 401 for GET /v1/backup/health without X-Cron-Secret', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/backup/health');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should return 401 for POST /v1/backup/metadata without X-Cron-Secret', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/backup/metadata');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should return 401 for POST /v1/backup/drill without X-Cron-Secret', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/backup/drill');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should return 401 for GET /v1/backup/procedures without X-Cron-Secret', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/backup/procedures');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('With valid X-Cron-Secret (guarded by CronSecretGuard)', () => {
    // Note: These tests verify the routes are reachable and properly guarded.
    // Actual validation depends on CronSecretGuard implementation and
    // whether a valid CRON_SECRET environment variable is configured.
    // If CRON_SECRET is not configured, requests will fail with 401 Unauthorized
    // (guard's expected behavior for missing/invalid credentials).

    it('GET /v1/backup/health should reach the controller', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/backup/health')
        .set('X-Cron-Secret', process.env.CRON_SECRET || 'invalid');

      // Will be 401 if secret doesn't match, or 200 if it does
      // The important thing is that it's not 404 (route is now reachable)
      expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(response.status);
    });

    it('POST /v1/backup/metadata should reach the controller', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/backup/metadata')
        .set('X-Cron-Secret', process.env.CRON_SECRET || 'invalid');

      expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(response.status);
    });

    it('POST /v1/backup/drill should reach the controller', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/backup/drill')
        .set('X-Cron-Secret', process.env.CRON_SECRET || 'invalid');

      expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(response.status);
    });

    it('GET /v1/backup/procedures should reach the controller', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/backup/procedures')
        .set('X-Cron-Secret', process.env.CRON_SECRET || 'invalid');

      expect([HttpStatus.OK, HttpStatus.UNAUTHORIZED]).toContain(response.status);
    });
  });
});
