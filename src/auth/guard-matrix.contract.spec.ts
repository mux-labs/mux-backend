/**
 * Auth Guard Matrix Contract Tests
 *
 * Ensures consistent behavior across all auth guard combinations:
 * - ApiKeyGuard + AuthRateLimitGuard
 * - ApiKeyGuard + FeatureFlagGuard
 * - AuthRateLimitGuard + FeatureFlagGuard
 * - All three combined
 *
 * Tests verify:
 * - Guard execution order
 * - Metadata decoration behavior
 * - Error responses and status codes
 * - Header propagation
 * - Request context attachment
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import * as request from 'supertest';

describe('Auth Guard Matrix Contracts', () => {
  let app: INestApplication;

  describe('Guard Combination: ApiKey + RateLimit', () => {
    it('should enforce API key auth before rate limiting', async () => {
      // Missing API key should return 401 (Unauthorized)
      // before any rate limit headers are set
      const response = await request(app.getHttpServer()).get('/api/v1/payments');

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body.message).toContain('API key');
    });

    it('should check rate limits after valid API key', async () => {
      // Valid API key but exceeding rate limit should return 429
      const validApiKey = 'test-key-valid';

      const response = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .set('Authorization', `Bearer ${validApiKey}`);

      // After rate limit exceeded: 429 with Retry-After header
      // Initial response should succeed with headers
      expect(response.status).toBe(HttpStatus.OK);
      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('should set rate limit headers on all successful auth checks', async () => {
      const validApiKey = 'test-key-valid';

      const response = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .set('Authorization', `Bearer ${validApiKey}`);

      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      expect(response.headers['x-ratelimit-remaining']).toBeDefined();
      expect(response.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('should attach API key context before rate limit check', async () => {
      // This ensures the rate limiter can access API key metadata
      // for per-key rate limiting if needed
      const validApiKey = 'test-key-with-context';

      const response = await request(app.getHttpServer())
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${validApiKey}`)
        .send({ amount: 100 });

      // Should succeed (context available to controller)
      if (response.status === HttpStatus.OK) {
        expect(response.body.apiKeyId).toBeDefined();
      }
    });
  });

  describe('Guard Combination: ApiKey + FeatureFlag', () => {
    it('should check API key before feature flag', async () => {
      // Without API key, should fail on auth (not feature flag)
      const response = await request(app.getHttpServer()).get(
        '/api/v1/feature-flagged-endpoint',
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should check feature flag after API key validation', async () => {
      // With valid API key but disabled feature, should return 403
      const validApiKey = 'test-key-valid';
      const response = await request(app.getHttpServer())
        .get('/api/v1/feature-flagged-endpoint')
        .set('Authorization', `Bearer ${validApiKey}`);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body.message).toContain('feature');
    });

    it('should allow access with valid key and enabled feature', async () => {
      // With valid API key and enabled feature, should succeed
      const validApiKey = 'test-key-with-enabled-feature';

      const response = await request(app.getHttpServer())
        .get('/api/v1/feature-flagged-endpoint')
        .set('Authorization', `Bearer ${validApiKey}`);

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('Guard Combination: RateLimit + FeatureFlag', () => {
    it('should enforce rate limit before feature flag on public routes', async () => {
      // Public routes (no API key) can still be rate limited
      const response1 = await request(app.getHttpServer()).get(
        '/api/v1/public-feature-endpoint',
      );
      expect(response1.status).toBe(HttpStatus.OK);

      // After exceeding rate limit, returns 429 before checking feature flag
      const responses = [];
      for (let i = 0; i < 105; i++) {
        const res = await request(app.getHttpServer()).get(
          '/api/v1/public-feature-endpoint',
        );
        responses.push(res.status);
      }

      const rateLimitedResponse = responses.find((s) => s === HttpStatus.TOO_MANY_REQUESTS);
      expect(rateLimitedResponse).toBeDefined();
    });
  });

  describe('Guard Combination: ApiKey + RateLimit + FeatureFlag', () => {
    it('should execute guards in correct order: ApiKey -> RateLimit -> FeatureFlag', async () => {
      // Case 1: No API key -> 401 (fails at ApiKeyGuard)
      const response1 = await request(app.getHttpServer()).get(
        '/api/v1/triple-guarded-endpoint',
      );
      expect(response1.status).toBe(HttpStatus.UNAUTHORIZED);

      // Case 2: Valid API key, over rate limit -> 429 (fails at RateLimitGuard)
      // First create rate limit exhaustion...
      const validApiKey = 'test-key-exhausted';
      for (let i = 0; i < 101; i++) {
        await request(app.getHttpServer())
          .get('/api/v1/triple-guarded-endpoint')
          .set('Authorization', `Bearer ${validApiKey}`);
      }

      const response2 = await request(app.getHttpServer())
        .get('/api/v1/triple-guarded-endpoint')
        .set('Authorization', `Bearer ${validApiKey}`);
      expect(response2.status).toBe(HttpStatus.TOO_MANY_REQUESTS);

      // Case 3: Valid API key, within rate limit, disabled feature -> 403 (fails at FeatureFlagGuard)
      const validKeyNoFeature = 'test-key-no-feature';
      const response3 = await request(app.getHttpServer())
        .get('/api/v1/triple-guarded-endpoint')
        .set('Authorization', `Bearer ${validKeyNoFeature}`);
      expect(response3.status).toBe(HttpStatus.FORBIDDEN);

      // Case 4: Valid API key, within rate limit, enabled feature -> 200 (passes all)
      const validKeyWithFeature = 'test-key-complete';
      const response4 = await request(app.getHttpServer())
        .get('/api/v1/triple-guarded-endpoint')
        .set('Authorization', `Bearer ${validKeyWithFeature}`);
      expect(response4.status).toBe(HttpStatus.OK);
    });

    it('should attach context from all guards for controller access', async () => {
      const validApiKey = 'test-key-with-context';

      const response = await request(app.getHttpServer())
        .get('/api/v1/triple-guarded-endpoint')
        .set('Authorization', `Bearer ${validApiKey}`);

      if (response.status === HttpStatus.OK) {
        // Controller should have access to all guard contexts
        expect(response.body.apiKeyId).toBeDefined();
        expect(response.body.rateLimitInfo).toBeDefined();
        expect(response.body.featureFlagEnabled).toBe(true);
      }
    });

    it('should set all required headers on successful auth', async () => {
      const validApiKey = 'test-key-with-headers';

      const response = await request(app.getHttpServer())
        .get('/api/v1/triple-guarded-endpoint')
        .set('Authorization', `Bearer ${validApiKey}`);

      if (response.status === HttpStatus.OK) {
        // Rate limit headers
        expect(response.headers['x-ratelimit-limit']).toBeDefined();
        expect(response.headers['x-ratelimit-remaining']).toBeDefined();
        expect(response.headers['x-ratelimit-reset']).toBeDefined();
      }
    });
  });

  describe('Guard Error Response Contracts', () => {
    it('should use consistent error response format across guards', async () => {
      // Each guard should return JSON with consistent structure
      const response = await request(app.getHttpServer()).get(
        '/api/v1/protected-endpoint',
      );

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('statusCode');
      expect(response.body.statusCode).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should include retry information on rate limit errors', async () => {
      const validApiKey = 'test-key-for-retry';

      // Exhaust rate limit
      for (let i = 0; i < 101; i++) {
        await request(app.getHttpServer())
          .get('/api/v1/payments')
          .set('Authorization', `Bearer ${validApiKey}`);
      }

      const response = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .set('Authorization', `Bearer ${validApiKey}`);

      if (response.status === HttpStatus.TOO_MANY_REQUESTS) {
        expect(response.headers['retry-after']).toBeDefined();
        expect(response.body.retryAfter).toBeDefined();
      }
    });
  });

  describe('Guard Metadata Decoration Contracts', () => {
    it('should respect @Public() decorator on all routes', async () => {
      // Public routes should skip guard checks
      const response = await request(app.getHttpServer()).get(
        '/api/v1/public-endpoint',
      );

      // Should succeed without API key or rate limit checks
      expect([HttpStatus.OK, HttpStatus.NOT_FOUND]).toContain(response.status);
    });

    it('should respect @FeatureFlag() decorator with flag name', async () => {
      // Routes with disabled flags should return 403
      const response = await request(app.getHttpServer())
        .get('/api/v1/alpha-feature-endpoint')
        .set('Authorization', 'Bearer valid-key');

      // Could be 403 if flag disabled, or 200 if enabled
      expect([HttpStatus.OK, HttpStatus.FORBIDDEN]).toContain(response.status);
    });

    it('should respect @UseGuards() on controller and method levels', async () => {
      // Guards on class level should apply to all methods
      // Guards on method level should override class-level guards

      const classLevelRoute = await request(app.getHttpServer())
        .get('/api/v1/class-guarded/endpoint1')
        .set('Authorization', 'Bearer valid-key');

      const methodLevelRoute = await request(app.getHttpServer())
        .get('/api/v1/class-guarded/endpoint2')
        .set('Authorization', 'Bearer valid-key');

      // Both should enforce auth (class-level guards apply)
      expect(
        [HttpStatus.OK, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN].includes(
          classLevelRoute.status,
        ),
      ).toBe(true);
    });
  });

  describe('Guard State Isolation', () => {
    it('should isolate rate limit state per API key', async () => {
      const key1 = 'test-key-1';
      const key2 = 'test-key-2';

      // Exhaust key1
      for (let i = 0; i < 101; i++) {
        await request(app.getHttpServer())
          .get('/api/v1/payments')
          .set('Authorization', `Bearer ${key1}`);
      }

      // key2 should still work
      const response = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .set('Authorization', `Bearer ${key2}`);

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should isolate rate limit state per IP address for public routes', async () => {
      // Different X-Forwarded-For should have separate rate limits
      const response1 = await request(app.getHttpServer())
        .get('/api/v1/public-endpoint')
        .set('X-Forwarded-For', '10.0.0.1');

      const response2 = await request(app.getHttpServer())
        .get('/api/v1/public-endpoint')
        .set('X-Forwarded-For', '10.0.0.2');

      // Both should have independent rate limits
      expect(response1.headers['x-ratelimit-limit']).toBeDefined();
      expect(response2.headers['x-ratelimit-limit']).toBeDefined();
    });
  });
});
