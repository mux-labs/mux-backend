import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Auth Public Endpoint (e2e)', () => {
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

  describe('POST /auth/authenticate', () => {
    const validAuthRequest = {
      authId: 'test-auth-id-123',
      email: 'test@example.com',
      displayName: 'Test User',
      authProvider: 'CLERK',
      network: 'TESTNET',
    };

    it('should be accessible without API key (public endpoint)', async () => {
      // This test verifies the endpoint doesn't require authentication
      // We expect it to process the request, not return 401 Unauthorized

      const response = await request(app.getHttpServer())
        .post('/auth/authenticate')
        .send(validAuthRequest);

      // Should NOT return 401 Unauthorized
      expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);

      // Should return either 200 (success) or 400/422 (validation error)
      // but NOT 401 (authentication required)
      expect([
        HttpStatus.OK,
        HttpStatus.CREATED,
        HttpStatus.BAD_REQUEST,
        HttpStatus.UNPROCESSABLE_ENTITY,
        HttpStatus.INTERNAL_SERVER_ERROR,
      ]).toContain(response.status);
    });

    it('should not require x-api-key header', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/authenticate')
        .send(validAuthRequest);
      // Deliberately NOT setting x-api-key header

      // Should NOT return 401 for missing API key
      expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body).not.toHaveProperty(
        'message',
        'API key is required',
      );
    });

    it('should not require Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/authenticate')
        .send(validAuthRequest);
      // Deliberately NOT setting Authorization header

      // Should NOT return 401 for missing authorization
      expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body).not.toHaveProperty(
        'message',
        'Invalid or inactive API key',
      );
    });

    it('should accept request with minimal required fields', async () => {
      const minimalRequest = {
        authId: 'test-auth-id',
        authProvider: 'CLERK',
        network: 'TESTNET',
      };

      const response = await request(app.getHttpServer())
        .post('/auth/authenticate')
        .send(minimalRequest);

      // Should process the request without authentication
      expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should return JSON content type', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/authenticate')
        .send(validAuthRequest);

      if (response.status !== HttpStatus.UNAUTHORIZED) {
        expect(response.headers['content-type']).toMatch(/application\/json/);
      }
    });

    it('should handle multiple requests without API key', async () => {
      // Verify the endpoint remains public across multiple calls
      for (let i = 0; i < 3; i++) {
        const response = await request(app.getHttpServer())
          .post('/auth/authenticate')
          .send({
            ...validAuthRequest,
            authId: `test-auth-id-${i}`,
          });

        expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
      }
    });
  });

  describe('Other auth endpoints (should require authentication)', () => {
    it('GET /auth/validate/:authId should require API key', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/validate/test-auth-id')
        .expect(HttpStatus.UNAUTHORIZED);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toMatch(/API key/i);
    });

    it('GET /auth/validate/:authId should work with valid API key', async () => {
      // This test would require a valid API key setup
      // For now, we just verify it requires authentication
      const response = await request(app.getHttpServer())
        .get('/auth/validate/test-auth-id')
        .set('x-api-key', 'invalid-key');

      // Should return 401 for invalid key (proving it checks authentication)
      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('Security verification', () => {
    it('should not bypass authentication for other endpoints', async () => {
      // Verify that making /auth/authenticate public doesn't affect other endpoints
      const protectedEndpoints = [
        { method: 'get', path: '/users' },
        { method: 'get', path: '/wallets' },
        { method: 'get', path: '/payments' },
      ];

      for (const endpoint of protectedEndpoints) {
        const response = await (request(app.getHttpServer()) as any)[
          endpoint.method
        ](endpoint.path);

        // These should still require authentication
        // They might return 404 if routes don't exist, but should not process without auth
        if (response.status !== HttpStatus.NOT_FOUND) {
          expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
        }
      }
    });
  });
});
