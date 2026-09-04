import { AuthMetricsService, AuthOutcome } from './auth-metrics.service';
import { Registry } from 'prom-client';

/**
 * Creates a fresh AuthMetricsService with an isolated prom-client Registry so
 * tests do not pollute (or conflict with) the global prom-client registry.
 */
function makeService(): { service: AuthMetricsService; registry: Registry } {
  const registry = new Registry();
  const service = new AuthMetricsService();
  // De-register the gauges that were added to the global registry in the ctor,
  // then re-register against the isolated test registry.
  service['promGauges'].length = 0;
  service.registerPromGauges(registry);
  return { service, registry };
}

describe('AuthMetricsService', () => {
  let service: AuthMetricsService;
  let registry: Registry;

  beforeEach(() => {
    ({ service, registry } = makeService());
  });

  afterEach(() => {
    registry.clear();
  });

  describe('initial state', () => {
    it('returns zero counters on a fresh instance', () => {
      const snap = service.getSnapshot();
      expect(snap.totalAttempts).toBe(0);
      expect(snap.rateLimitHits).toBe(0);
      expect(snap.averageLatencyMs).toBe(0);
      expect(snap.p95LatencyMs).toBe(0);
    });

    it('all outcome buckets start at 0', () => {
      const { outcomes } = service.getSnapshot();
      for (const val of Object.values(outcomes)) {
        expect(val).toBe(0);
      }
    });

    it('lastResetAt is a recent Date', () => {
      const before = Date.now();
      const svc = new AuthMetricsService();
      const after = Date.now();
      const snap = svc.getSnapshot();
      expect(snap.lastResetAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(snap.lastResetAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('recordAttempt()', () => {
    it('increments totalAttempts', () => {
      service.recordAttempt('success_returning_user', 50);
      expect(service.getSnapshot().totalAttempts).toBe(1);
    });

    it('increments the correct outcome bucket', () => {
      service.recordAttempt('success_new_user', 100);
      service.recordAttempt('success_new_user', 120);
      service.recordAttempt('failure_unknown', 10);

      const { outcomes } = service.getSnapshot();
      expect(outcomes.success_new_user).toBe(2);
      expect(outcomes.failure_unknown).toBe(1);
      expect(outcomes.success_returning_user).toBe(0);
    });

    it('does not cross-contaminate outcome buckets', () => {
      const allOutcomes: AuthOutcome[] = [
        'success_new_user',
        'success_returning_user',
        'failure_invalid_payload',
        'failure_user_inactive',
        'failure_wallet_error',
        'failure_jwt_verification',
        'failure_unknown',
      ];

      allOutcomes.forEach((o, i) => service.recordAttempt(o, i * 10));

      const { outcomes } = service.getSnapshot();
      allOutcomes.forEach((o) => expect(outcomes[o]).toBe(1));
    });

    it('computes correct average latency from a single sample', () => {
      service.recordAttempt('success_returning_user', 80);
      expect(service.getSnapshot().averageLatencyMs).toBe(80);
    });

    it('computes correct average latency from multiple samples', () => {
      service.recordAttempt('success_returning_user', 100);
      service.recordAttempt('success_returning_user', 200);
      service.recordAttempt('success_returning_user', 300);
      expect(service.getSnapshot().averageLatencyMs).toBe(200);
    });

    it('computes p95 latency correctly with enough samples', () => {
      // 20 samples: 1..20ms — p95 should be ~19ms
      for (let i = 1; i <= 20; i++) {
        service.recordAttempt('success_returning_user', i);
      }
      // sorted = [1..20], p95 index = ceil(0.95*20)-1 = 19-1 = 18 → value=19
      expect(service.getSnapshot().p95LatencyMs).toBe(19);
    });
  });

  describe('recordRateLimitHit()', () => {
    it('increments rateLimitHits', () => {
      service.recordRateLimitHit();
      service.recordRateLimitHit();
      expect(service.getSnapshot().rateLimitHits).toBe(2);
    });

    it('does not affect totalAttempts', () => {
      service.recordRateLimitHit();
      expect(service.getSnapshot().totalAttempts).toBe(0);
    });
  });

  describe('reset()', () => {
    it('zeros all counters', () => {
      service.recordAttempt('success_new_user', 100);
      service.recordAttempt('failure_unknown', 50);
      service.recordRateLimitHit();
      service.reset();

      const snap = service.getSnapshot();
      expect(snap.totalAttempts).toBe(0);
      expect(snap.rateLimitHits).toBe(0);
      expect(snap.averageLatencyMs).toBe(0);
      expect(snap.p95LatencyMs).toBe(0);
      for (const val of Object.values(snap.outcomes)) {
        expect(val).toBe(0);
      }
    });

    it('updates lastResetAt', async () => {
      const before = service.getSnapshot().lastResetAt;
      // Small delay to guarantee timestamp advances
      await new Promise((r) => setTimeout(r, 2));
      service.reset();
      const after = service.getSnapshot().lastResetAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    it('allows new recordings after reset', () => {
      service.recordAttempt('success_new_user', 100);
      service.reset();
      service.recordAttempt('success_returning_user', 50);
      const snap = service.getSnapshot();
      expect(snap.totalAttempts).toBe(1);
      expect(snap.outcomes.success_returning_user).toBe(1);
      expect(snap.outcomes.success_new_user).toBe(0);
    });
  });

  describe('ring-buffer behaviour', () => {
    it('handles more samples than the ring-buffer capacity gracefully', () => {
      // Fill well beyond MAX_LATENCY_SAMPLES (1000) — just verify it doesn't
      // throw and produces a sensible average.
      const count = 1100;
      for (let i = 0; i < count; i++) {
        service.recordAttempt('success_returning_user', 100);
      }
      const snap = service.getSnapshot();
      expect(snap.totalAttempts).toBe(count);
      expect(snap.averageLatencyMs).toBe(100);
    });
  });

  describe('getSnapshot() immutability', () => {
    it('returns a copy of the outcomes object, not a live reference', () => {
      const snap1 = service.getSnapshot();
      service.recordAttempt('success_new_user', 10);
      const snap2 = service.getSnapshot();
      // snap1 should not reflect the new recording
      expect(snap1.outcomes.success_new_user).toBe(0);
      expect(snap2.outcomes.success_new_user).toBe(1);
    });
  });

  // ─── Prometheus scrape integration ────────────────────────────────────────
  // These tests verify that auth counters surface on the /v1/metrics scrape
  // path (i.e. in the prom-client registry) so Prometheus can collect them.

  describe('Prometheus gauge registration', () => {
    it('registers auth_attempts_total gauge in the registry', () => {
      const metric = registry.getSingleMetric('auth_attempts_total');
      expect(metric).toBeDefined();
    });

    it('registers auth_rate_limit_hits_total gauge in the registry', () => {
      const metric = registry.getSingleMetric('auth_rate_limit_hits_total');
      expect(metric).toBeDefined();
    });

    it('registers auth_outcome_total gauge with outcome label in the registry', () => {
      const metric = registry.getSingleMetric('auth_outcome_total');
      expect(metric).toBeDefined();
    });

    it('registers auth_latency_average_ms gauge in the registry', () => {
      const metric = registry.getSingleMetric('auth_latency_average_ms');
      expect(metric).toBeDefined();
    });

    it('registers auth_latency_p95_ms gauge in the registry', () => {
      const metric = registry.getSingleMetric('auth_latency_p95_ms');
      expect(metric).toBeDefined();
    });

    it('auth_attempts_total gauge reflects current counter at scrape time', async () => {
      service.recordAttempt('success_new_user', 50);
      service.recordAttempt('success_returning_user', 60);
      const metricsText = await registry.metrics();
      expect(metricsText).toMatch(/auth_attempts_total 2/);
    });

    it('auth_rate_limit_hits_total gauge reflects current counter at scrape time', async () => {
      service.recordRateLimitHit();
      service.recordRateLimitHit();
      service.recordRateLimitHit();
      const metricsText = await registry.metrics();
      expect(metricsText).toMatch(/auth_rate_limit_hits_total 3/);
    });

    it('auth_outcome_total gauge includes labeled outcome series at scrape time', async () => {
      service.recordAttempt('success_new_user', 100);
      service.recordAttempt('failure_unknown', 20);
      const metricsText = await registry.metrics();
      expect(metricsText).toMatch(/auth_outcome_total\{outcome="success_new_user"\} 1/);
      expect(metricsText).toMatch(/auth_outcome_total\{outcome="failure_unknown"\} 1/);
      expect(metricsText).toMatch(/auth_outcome_total\{outcome="success_returning_user"\} 0/);
    });

    it('gauge values update across successive scrapes without re-registration', async () => {
      service.recordAttempt('success_new_user', 50);
      const first = await registry.metrics();
      expect(first).toMatch(/auth_attempts_total 1/);

      service.recordAttempt('success_returning_user', 60);
      const second = await registry.metrics();
      expect(second).toMatch(/auth_attempts_total 2/);
    });

    it('does not double-register when registerPromGauges is called twice on the same registry', () => {
      // Second call should be a no-op (metric name already present).
      expect(() => service.registerPromGauges(registry)).not.toThrow();
      const names = registry.getMetricsAsArray().map((m: any) => m.name);
      const authNames = names.filter((n: string) => n.startsWith('auth_'));
      // Each auth metric should appear exactly once.
      const uniqueAuthNames = new Set(authNames);
      expect(uniqueAuthNames.size).toBe(authNames.length);
    });
  });
});
