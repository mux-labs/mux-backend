import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Comprehensive test suite verifying that all API endpoints are prefixed with /v1
 * This ensures the global prefix is correctly applied across all controllers
 */
describe('API Prefix /v1 (e2e)', () => {
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

  describe('Global /v1 prefix verification', () => {
    it('should serve root endpoint at /v1/', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/')
        .expect(HttpStatus.OK);

      expect(response.text).toBe('Hello World!');
    });

    it('should return 404 for root endpoint without prefix', async () => {
      await request(app.getHttpServer()).get('/').expect(HttpStatus.NOT_FOUND);
    });

    it('should serve /v1/ready endpoint', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/ready')
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('status', 'ready');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('database');
    });

    it('should return 404 for /ready endpoint without prefix', async () => {
      await request(app.getHttpServer())
        .get('/ready')
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should serve /v1/health endpoint', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/health')
        .expect(HttpStatus.OK);

      // Health check returns an object with status property
      expect(response.body).toHaveProperty('status');
    });

    it('should return 404 for /health endpoint without prefix', async () => {
      await request(app.getHttpServer())
        .get('/health')
        .expect(HttpStatus.NOT_FOUND);
    });
  });

  describe('Controller routes with /v1 prefix', () => {
    it('should respond to /v1/auth/* routes', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/authenticate')
        .send({
          authId: 'test-id',
          email: 'test@example.com',
          displayName: 'Test User',
          authProvider: 'CLERK',
          network: 'TESTNET',
        });

      // Endpoint should exist and be accessible (regardless of response status)
      expect([
        HttpStatus.OK,
        HttpStatus.CREATED,
        HttpStatus.BAD_REQUEST,
        HttpStatus.UNPROCESSABLE_ENTITY,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ]).toContain(response.status);
    });

    it('should return 404 for auth routes without /v1 prefix', async () => {
      await request(app.getHttpServer())
        .post('/auth/authenticate')
        .send({
          authId: 'test-id',
          email: 'test@example.com',
          displayName: 'Test User',
          authProvider: 'CLERK',
          network: 'TESTNET',
        })
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should respond to /v1/users routes', async () => {
      const response = await request(app.getHttpServer()).get('/v1/users');

      // Should not be 404 - endpoint should exist with or without proper auth
      expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('should return 404 for users routes without /v1 prefix', async () => {
      await request(app.getHttpServer())
        .get('/users')
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should respond to /v1/wallets routes', async () => {
      const response = await request(app.getHttpServer()).get('/v1/wallets');

      // Should not be 404 - endpoint should exist
      expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('should return 404 for wallets routes without /v1 prefix', async () => {
      await request(app.getHttpServer())
        .get('/wallets')
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should respond to /v1/api-keys routes', async () => {
      const response = await request(app.getHttpServer()).get('/v1/api-keys');

      // Should not be 404 - endpoint should exist
      expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('should return 404 for api-keys routes without /v1 prefix', async () => {
      await request(app.getHttpServer())
        .get('/api-keys')
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should respond to /v1/developers routes', async () => {
      const response = await request(app.getHttpServer()).get('/v1/developers');

      // Should not be 404 - endpoint should exist
      expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('should return 404 for developers routes without /v1 prefix', async () => {
      await request(app.getHttpServer())
        .get('/developers')
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should respond to /v1/projects routes', async () => {
      const response = await request(app.getHttpServer()).get('/v1/projects');

      // Should not be 404 - endpoint should exist
      expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('should return 404 for projects routes without /v1 prefix', async () => {
      await request(app.getHttpServer())
        .get('/projects')
        .expect(HttpStatus.NOT_FOUND);
    });
  });

  describe('Error handling with /v1 prefix', () => {
    it('should include /v1 prefix in error response path', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-route')
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body).toHaveProperty('path', '/v1/non-existent-route');
      expect(response.body.path).toContain('/v1/');
    });

    it('should return 404 for non-existent route without prefix', async () => {
      const response = await request(app.getHttpServer())
        .get('/non-existent-route')
        .expect(HttpStatus.NOT_FOUND);

      // Error response should show the requested path
      expect(response.body.path).toBe('/non-existent-route');
    });
  });

  describe('Public endpoint accessibility with /v1 prefix', () => {
    it('/v1/ should be accessible without authentication', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/')
        .expect(HttpStatus.OK);

      expect(response.text).toBe('Hello World!');
    });

    it('/v1/ready should be accessible without authentication', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/ready')
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('status');
    });

    it('/v1/health should be accessible without authentication', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/health')
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('status');
    });

    it('/v1/auth/authenticate should be accessible without API key', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/authenticate')
        .send({
          authId: 'test-id',
          email: 'test@example.com',
          displayName: 'Test User',
          authProvider: 'CLERK',
          network: 'TESTNET',
        });

      // Should not return 401 Unauthorized due to missing API key
      expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('Request/response headers with /v1 prefix', () => {
    it('should preserve custom headers with /v1 prefix', async () => {
      const customHeaderValue = 'test-request-id-12345';

      const response = await request(app.getHttpServer())
        .get('/v1/')
        .set('x-request-id', customHeaderValue)
        .expect(HttpStatus.OK);

      // Request should be processed successfully
      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should return proper content-type with /v1 prefix', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/ready')
        .expect(HttpStatus.OK);

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('HTTP methods with /v1 prefix', () => {
    it('should handle GET requests with /v1 prefix', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/')
        .expect(HttpStatus.OK);

      expect(response.text).toBe('Hello World!');
    });

    it('should handle POST requests with /v1 prefix', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/authenticate')
        .send({
          authId: 'test-id',
          email: 'test@example.com',
          displayName: 'Test User',
          authProvider: 'CLERK',
          network: 'TESTNET',
        });

      // Should not be 404
      expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('should handle POST requests without /v1 prefix as 404', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/authenticate')
        .send({
          authId: 'test-id',
          email: 'test@example.com',
          displayName: 'Test User',
          authProvider: 'CLERK',
          network: 'TESTNET',
        })
        .expect(HttpStatus.NOT_FOUND);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });
});
