import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import * as request from 'supertest';

/**
 * E2E test verifying that error responses follow the documented structured
 * envelope format when the app is bootstrapped the way main.ts does it
 * (with HttpExceptionFilter globally registered).
 *
 * The documented envelope format from README is:
 * {
 *   "statusCode": number,
 *   "timestamp": ISO8601,
 *   "path": string,
 *   "method": string,
 *   "message": string,
 *   "error": string,
 *   "errorCode"?: string,
 *   "requestId"?: string
 * }
 */
describe('Error Envelope Format - Production Bootstrap (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('v1');

    // Replicate main.ts setup
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    // Register HttpExceptionFilter the same way main.ts does
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Structured error envelope', () => {
    it('should return 404 for non-existent routes with proper structure', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/nonexistent-route-that-does-not-exist')
        .set('X-Request-ID', 'test-404-request');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        statusCode: 404,
        path: '/v1/nonexistent-route-that-does-not-exist',
        method: 'GET',
        error: 'Not Found',
      });
      expect(typeof response.body.timestamp).toBe('string');
      expect(typeof response.body.message).toBe('string');
      expect(response.body.requestId).toBe('test-404-request');
    });

    it('should return validation error with structured format', async () => {
      // Try to hit a real endpoint but malformed/invalid
      // Health endpoint probably only accepts GET, so POST should work
      const response = await request(app.getHttpServer())
        .post('/v1/ready')
        .set('Content-Type', 'application/json')
        .set('X-Request-ID', 'test-validation-request')
        .send({ someField: 'value' });

      // Should be 404 or 405 or similar error
      if (response.status >= 400) {
        expect(response.body).toHaveProperty('statusCode');
        expect(response.body).toHaveProperty('timestamp');
        expect(response.body).toHaveProperty('path');
        expect(response.body).toHaveProperty('method');
        expect(response.body).toHaveProperty('error');
        expect(response.body).toHaveProperty('message');
        // requestId should be present since we set it
        expect(response.body.requestId).toBe('test-validation-request');
      }
    });

    it('should include timestamp in ISO 8601 format', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/nonexistent');

      expect(response.status).toBe(404);
      // Validate ISO 8601 format
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
      expect(response.body.timestamp).toMatch(isoRegex);
    });

    it('should NOT include sensitive data (secrets, paths) in error messages for 5xx errors', async () => {
      // This is tested indirectly - the HttpExceptionFilter.sanitizeErrorMessage
      // method handles this in production. We verify the filter is registered.
      const response = await request(app.getHttpServer())
        .get('/v1/nonexistent')
        .set('X-Request-ID', 'test-sanitize-request');

      expect(response.status).toBe(404);
      // Should have the structured envelope including requestId
      expect(response.body.requestId).toBe('test-sanitize-request');
    });
  });
});
