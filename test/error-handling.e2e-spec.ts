import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/filters';

describe('Error Handling (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Register the global exception filter
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Structured error responses', () => {
    it('should return structured error for 404 Not Found', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      // Verify structured error response
      expect(response.body).toHaveProperty('statusCode', HttpStatus.NOT_FOUND);
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('path', '/v1/non-existent-endpoint');
      expect(response.body).toHaveProperty('method', 'GET');
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('error', 'Not Found');

      // Verify timestamp is valid ISO string
      expect(new Date(response.body.timestamp).toString()).not.toBe(
        'Invalid Date',
      );
    });

    it('should include request ID in error response when provided', async () => {
      const requestId = 'test-request-123';

      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .set('x-request-id', requestId)
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body).toHaveProperty('requestId', requestId);
    });

    it('should not include request ID when not provided', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body.requestId).toBeUndefined();
    });
  });

  describe('Error response consistency', () => {
    it('should have consistent structure across different error types', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      // Verify all required fields are present
      const requiredFields = [
        'statusCode',
        'timestamp',
        'path',
        'method',
        'message',
        'error',
      ];

      requiredFields.forEach((field) => {
        expect(response.body).toHaveProperty(field);
      });

      // Verify field types
      expect(typeof response.body.statusCode).toBe('number');
      expect(typeof response.body.timestamp).toBe('string');
      expect(typeof response.body.path).toBe('string');
      expect(typeof response.body.method).toBe('string');
      expect(typeof response.body.error).toBe('string');
      // message can be string or array
      expect(
        typeof response.body.message === 'string' ||
          Array.isArray(response.body.message),
      ).toBe(true);
    });

    it('should include correct HTTP method in error response', async () => {
      const getResponse = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      expect(getResponse.body.method).toBe('GET');

      const postResponse = await request(app.getHttpServer())
        .post('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      expect(postResponse.body.method).toBe('POST');
    });

    it('should include correct path in error response', async () => {
      const testPath = '/v1/api/test/error/path';

      const response = await request(app.getHttpServer())
        .get(testPath)
        .expect(HttpStatus.NOT_FOUND);

      expect(response.body.path).toBe(testPath);
    });
  });

  describe('Security considerations', () => {
    it('should not expose stack traces in error responses', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      // Verify no stack trace is exposed
      expect(response.body).not.toHaveProperty('stack');
      expect(response.body).not.toHaveProperty('stackTrace');

      // Verify response doesn't contain file paths
      const responseString = JSON.stringify(response.body);
      expect(responseString).not.toMatch(/\.ts:\d+/);
      expect(responseString).not.toMatch(/\.js:\d+/);
    });

    it('should not expose internal implementation details', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      const responseString = JSON.stringify(response.body);

      // Should not contain internal paths or module names
      expect(responseString).not.toContain('node_modules');
      expect(responseString).not.toContain('dist/');
      expect(responseString).not.toContain('src/');
    });
  });

  describe('Content-Type header', () => {
    it('should return JSON content type for error responses', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/non-existent-endpoint')
        .expect(HttpStatus.NOT_FOUND);

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Different HTTP methods', () => {
    const methods = ['get', 'post', 'put', 'patch', 'delete'];

    methods.forEach((method) => {
      it(`should handle ${method.toUpperCase()} requests with structured errors`, async () => {
        const response = await (request(app.getHttpServer()) as any)
          [method]('/v1/non-existent-endpoint')
          .expect(HttpStatus.NOT_FOUND);

        expect(response.body).toHaveProperty('statusCode');
        expect(response.body).toHaveProperty('timestamp');
        expect(response.body).toHaveProperty('path');
        expect(response.body).toHaveProperty('method', method.toUpperCase());
        expect(response.body).toHaveProperty('message');
        expect(response.body).toHaveProperty('error');
      });
    });
  });
});
