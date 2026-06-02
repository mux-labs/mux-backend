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
  });
});
