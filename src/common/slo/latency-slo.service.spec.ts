import { LatencySloService } from './latency-slo.service';
import { SloDefinition } from './slo.types';

/**
 * Unit tests for the LatencySloService (Issue #2 – Latency SLOs).
 */
describe('LatencySloService', () => {
  const TEST_SLOS: SloDefinition[] = [
    {
      name: 'wallet_read',
      routePrefix: '/wallets',
      method: 'GET',
      thresholdMs: 200,
      targetCompliance: 0.99,
    },
    {
      name: 'global',
      routePrefix: '/',
      method: '*',
      thresholdMs: 1000,
      targetCompliance: 0.99,
    },
  ];

  let service: LatencySloService;

  beforeEach(() => {
    service = new LatencySloService(TEST_SLOS);
  });

  // ---------------------------------------------------------------------------
  // record()
  // ---------------------------------------------------------------------------
  describe('record()', () => {
    it('accepts a valid observation without throwing', () => {
      expect(() =>
        service.record({
          route: '/wallets',
          method: 'GET',
          durationMs: 50,
          timestamp: new Date(),
        }),
      ).not.toThrow();
    });

    it('only assigns the observation to matching SLO buckets', () => {
      // A GET /wallets request matches both wallet_read and global
      service.record({
        route: '/wallets/abc',
        method: 'GET',
        durationMs: 50,
        timestamp: new Date(),
      });

      const walletResult = service.getComplianceFor('wallet_read')!;
      const globalResult = service.getComplianceFor('global')!;

      expect(walletResult.totalRequests).toBe(1);
      expect(globalResult.totalRequests).toBe(1);
    });

    it('does not assign a POST /wallets observation to the wallet_read (GET-only) SLO', () => {
      service.record({
        route: '/wallets',
        method: 'POST',
        durationMs: 300,
        timestamp: new Date(),
      });

      const walletReadResult = service.getComplianceFor('wallet_read')!;
      // POST should NOT match wallet_read (GET-only SLO)
      expect(walletReadResult.totalRequests).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getCompliance()
  // ---------------------------------------------------------------------------
  describe('getCompliance()', () => {
    it('returns a result for every defined SLO', () => {
      const results = service.getCompliance();
      expect(results).toHaveLength(TEST_SLOS.length);
      expect(results.map((r) => r.sloName)).toEqual(
        TEST_SLOS.map((s) => s.name),
      );
    });

    it('reports compliant=true when no observations exist', () => {
      const results = service.getCompliance();
      for (const r of results) {
        expect(r.compliant).toBe(true);
        expect(r.totalRequests).toBe(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // SLO compliance evaluation
  // ---------------------------------------------------------------------------
  describe('compliance evaluation', () => {
    it('reports compliant=true when all requests are within the threshold', () => {
      // Add 100 fast requests (50 ms each, threshold 200 ms)
      for (let i = 0; i < 100; i++) {
        service.record({
          route: '/wallets',
          method: 'GET',
          durationMs: 50,
          timestamp: new Date(),
        });
      }

      const result = service.getComplianceFor('wallet_read')!;
      expect(result.compliant).toBe(true);
      expect(result.measuredCompliance).toBe(1);
      expect(result.requestsWithinThreshold).toBe(100);
    });

    it('reports compliant=false when too many requests exceed the threshold', () => {
      // 10 slow (300 ms, over 200 ms threshold) + 90 fast → 90% compliance
      // Target is 99% → should NOT be compliant
      for (let i = 0; i < 10; i++) {
        service.record({
          route: '/wallets',
          method: 'GET',
          durationMs: 300,
          timestamp: new Date(),
        });
      }
      for (let i = 0; i < 90; i++) {
        service.record({
          route: '/wallets',
          method: 'GET',
          durationMs: 50,
          timestamp: new Date(),
        });
      }

      const result = service.getComplianceFor('wallet_read')!;
      expect(result.compliant).toBe(false);
      expect(result.measuredCompliance).toBeCloseTo(0.9);
      expect(result.totalRequests).toBe(100);
    });

    it('computes p50 / p95 / p99 percentiles correctly', () => {
      // 100 sorted observations: 1 ms … 100 ms
      for (let i = 1; i <= 100; i++) {
        service.record({
          route: '/wallets',
          method: 'GET',
          durationMs: i,
          timestamp: new Date(),
        });
      }

      const result = service.getComplianceFor('wallet_read')!;
      expect(result.p50Ms).toBe(50);
      expect(result.p95Ms).toBe(95);
      expect(result.p99Ms).toBe(99);
    });
  });

  // ---------------------------------------------------------------------------
  // getComplianceFor()
  // ---------------------------------------------------------------------------
  describe('getComplianceFor()', () => {
    it('returns null for an unknown SLO name', () => {
      expect(service.getComplianceFor('non_existent')).toBeNull();
    });

    it('returns a result with correct structure for a known SLO', () => {
      service.record({
        route: '/wallets/123',
        method: 'GET',
        durationMs: 100,
        timestamp: new Date(),
      });

      const result = service.getComplianceFor('wallet_read')!;
      expect(result).toMatchObject({
        sloName: 'wallet_read',
        thresholdMs: 200,
        targetCompliance: 0.99,
        totalRequests: 1,
        requestsWithinThreshold: 1,
        compliant: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // resetWindows()
  // ---------------------------------------------------------------------------
  describe('resetWindows()', () => {
    it('clears all recorded observations', () => {
      service.record({
        route: '/wallets',
        method: 'GET',
        durationMs: 50,
        timestamp: new Date(),
      });

      service.resetWindows();

      const result = service.getComplianceFor('wallet_read')!;
      expect(result.totalRequests).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Rolling window behaviour
  // ---------------------------------------------------------------------------
  describe('rolling window', () => {
    it('does not grow beyond WINDOW_SIZE observations', () => {
      // The private WINDOW_SIZE is 1000; feed 1100 observations.
      const localService = new LatencySloService([
        {
          name: 'wallet_read',
          routePrefix: '/wallets',
          method: 'GET',
          thresholdMs: 200,
          targetCompliance: 0.99,
        },
      ]);

      for (let i = 0; i < 1100; i++) {
        localService.record({
          route: '/wallets',
          method: 'GET',
          durationMs: 50,
          timestamp: new Date(),
        });
      }

      const result = localService.getComplianceFor('wallet_read')!;
      expect(result.totalRequests).toBeLessThanOrEqual(1000);
    });
  });
});
