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

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  describe('/health (GET)', () => {
    it('should return 200 with health status', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
    });

    it('should return valid timestamp', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body.timestamp).toBeDefined();
      expect(new Date(response.body.timestamp).toString()).not.toBe(
        'Invalid Date',
      );
    });

    it('should return uptime as a number', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should be accessible without authentication (public endpoint)', async () => {
      // The /health endpoint should not require API key or authentication
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
    });

    it('should return JSON content type', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should return consistent structure on multiple calls', async () => {
      const response1 = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      const response2 = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      // Both should have the same structure
      expect(response1.body).toHaveProperty('status');
      expect(response1.body).toHaveProperty('timestamp');
      expect(response1.body).toHaveProperty('uptime');

      expect(response2.body).toHaveProperty('status');
      expect(response2.body).toHaveProperty('timestamp');
      expect(response2.body).toHaveProperty('uptime');

      // Uptime should increase or stay the same
      expect(response2.body.uptime).toBeGreaterThanOrEqual(
        response1.body.uptime,
      );
    });

    it('should always return ok status', async () => {
      // Call multiple times to ensure it's always ok
      for (let i = 0; i < 3; i++) {
        const response = await request(app.getHttpServer())
          .get('/health')
          .expect(200);

        expect(response.body.status).toBe('ok');
      }
    });

    it('should respond quickly (liveness check should be fast)', async () => {
      const startTime = Date.now();

      await request(app.getHttpServer()).get('/health').expect(200);

      const duration = Date.now() - startTime;

      // Health check should respond in less than 100ms
      expect(duration).toBeLessThan(100);
    });
  });
});
