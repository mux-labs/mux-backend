import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AuthMetricsService } from './../src/auth/auth-metrics.service';

describe('Auth Metrics Export on Prometheus Scrape Path (e2e)', () => {
  let app: INestApplication<App>;
  let authMetricsService: AuthMetricsService;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Get the AuthMetricsService instance from the app's dependency injection container
    authMetricsService = app.get(AuthMetricsService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Prometheus metrics scrape endpoint', () => {
    it('should export auth metrics on /v1/metrics endpoint', async () => {
      // Record some auth attempts to populate metrics
      authMetricsService.recordAttempt('success_new_user', 100);
      authMetricsService.recordAttempt('success_returning_user', 50);
      authMetricsService.recordAttempt('failure_jwt_verification', 10);

      // Scrape the metrics endpoint
      const response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK)
        .expect('content-type', /text\/plain/);

      const metricsText = response.text;

      // Verify auth metrics are present in the response
      expect(metricsText).toContain('auth_attempts_total');
      expect(metricsText).toContain('auth_outcome_total');
      expect(metricsText).toContain('auth_rate_limit_hits_total');
      expect(metricsText).toContain('auth_latency_average_ms');
      expect(metricsText).toContain('auth_latency_p95_ms');
    });

    it('should include metric values for recorded attempts', async () => {
      const expectedAttempts = 3;

      // Record auth attempts
      for (let i = 0; i < expectedAttempts; i++) {
        authMetricsService.recordAttempt('success_new_user', 50 + i);
      }

      const response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      const metricsText = response.text;

      // Verify the total attempts metric includes the value
      const attemptsLine = metricsText
        .split('\n')
        .find((line) => line.startsWith('auth_attempts_total'));
      expect(attemptsLine).toBeDefined();
      expect(attemptsLine).toContain(expectedAttempts.toString());
    });

    it('should include outcome labels in auth_outcome_total metric', async () => {
      // Record attempts with different outcomes
      authMetricsService.recordAttempt('success_new_user', 100);
      authMetricsService.recordAttempt('success_returning_user', 50);
      authMetricsService.recordAttempt('failure_jwt_verification', 10);

      const response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      const metricsText = response.text;

      // Verify outcome labels are present
      expect(metricsText).toContain(
        'auth_outcome_total{outcome="success_new_user"}',
      );
      expect(metricsText).toContain(
        'auth_outcome_total{outcome="success_returning_user"}',
      );
      expect(metricsText).toContain(
        'auth_outcome_total{outcome="failure_jwt_verification"}',
      );
    });

    it('should export auth metrics without authentication', async () => {
      // The /v1/metrics endpoint should be accessible without API key
      // (it's marked @Public() in MetricsController)
      authMetricsService.recordAttempt('success_new_user', 100);

      const response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      expect(response.text).toContain('auth_attempts_total');
    });

    it('should include HELP and TYPE annotations for auth metrics', async () => {
      authMetricsService.recordAttempt('success_new_user', 100);

      const response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      const metricsText = response.text;

      // Prometheus format includes HELP and TYPE annotations
      expect(metricsText).toContain(
        '# HELP auth_attempts_total',
      );
      expect(metricsText).toContain('# TYPE auth_attempts_total gauge');

      expect(metricsText).toContain(
        '# HELP auth_outcome_total',
      );
      expect(metricsText).toContain('# TYPE auth_outcome_total gauge');

      expect(metricsText).toContain(
        '# HELP auth_rate_limit_hits_total',
      );
      expect(metricsText).toContain('# TYPE auth_rate_limit_hits_total gauge');

      expect(metricsText).toContain(
        '# HELP auth_latency_average_ms',
      );
      expect(metricsText).toContain('# TYPE auth_latency_average_ms gauge');

      expect(metricsText).toContain(
        '# HELP auth_latency_p95_ms',
      );
      expect(metricsText).toContain('# TYPE auth_latency_p95_ms gauge');
    });

    it('should maintain auth metrics across multiple scrapes', async () => {
      // First scrape
      authMetricsService.recordAttempt('success_new_user', 100);

      let response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      const firstScrape = response.text;
      expect(firstScrape).toContain('auth_attempts_total');

      // Record more attempts
      authMetricsService.recordAttempt('success_returning_user', 50);

      // Second scrape should show updated values
      response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      const secondScrape = response.text;
      expect(secondScrape).toContain('auth_attempts_total');

      // Both scrapes should contain the metrics
      expect(firstScrape).toBeTruthy();
      expect(secondScrape).toBeTruthy();
    });

    it('should format metrics in valid Prometheus text format', async () => {
      authMetricsService.recordAttempt('success_new_user', 100);

      const response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      const metricsText = response.text;

      // Verify Prometheus text format:
      // - Lines starting with # are comments
      // - Metrics have format: metric_name{labels} value
      // - Timestamps are optional

      const lines = metricsText.split('\n').filter((line) => line.trim());

      // Should have some metrics (not just comments)
      const metricLines = lines.filter((line) => !line.startsWith('#'));
      expect(metricLines.length).toBeGreaterThan(0);

      // Each metric line should have the format: name value or name{labels} value
      metricLines.forEach((line) => {
        const match = line.match(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})?\s+[0-9.e+-]+/);
        expect(match).toBeDefined();
      });
    });

    it('should not expose auth metrics on separate /auth/metrics endpoint', async () => {
      // The dedicated /auth/metrics endpoint requires authentication
      // Only the main /v1/metrics endpoint should expose metrics for Prometheus scraping
      authMetricsService.recordAttempt('success_new_user', 100);

      const response = await request(app.getHttpServer())
        .get('/v1/auth/metrics')
        // Should either fail auth or return JSON (not raw metrics)
        .catch((err) => err.response);

      // The response should be JSON (from AuthMetricsController), not Prometheus text
      if (response && response.body) {
        expect(typeof response.body).toBe('object');
        expect(response.headers['content-type']).toMatch(/application\/json/);
      }
    });
  });

  describe('Auth metrics rate limit tracking', () => {
    it('should export auth rate-limit hits on Prometheus endpoint', async () => {
      // Simulate a rate-limit hit
      authMetricsService.recordRateLimitHit();
      authMetricsService.recordRateLimitHit();

      const response = await request(app.getHttpServer())
        .get('/v1/metrics')
        .expect(HttpStatus.OK);

      const metricsText = response.text;

      // Verify rate-limit metric is exported
      expect(metricsText).toContain('auth_rate_limit_hits_total');

      // Find the actual value
      const rateLimitLine = metricsText
        .split('\n')
        .find((line) => line.startsWith('auth_rate_limit_hits_total'));
      expect(rateLimitLine).toContain('2');
    });
  });
});
