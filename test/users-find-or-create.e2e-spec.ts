import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('POST /users/find-or-create (e2e)', () => {
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

  describe('authentication', () => {
    it('should require an API key', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .send({ authId: 'test-auth-id-e2e' });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should reject an invalid API key', async () => {
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_invalidkey')
        .send({ authId: 'test-auth-id-e2e' });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('idempotency semantics', () => {
    it('endpoint exists and returns non-404 with an API key attempt', async () => {
      // With an invalid key we expect 401, not 404 — confirming the route is registered
      const response = await request(app.getHttpServer())
        .post('/users/find-or-create')
        .set('Authorization', 'Bearer mux_test_somekey')
        .send({ authId: 'test-auth-id-e2e' });

      expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    });
  });
});
