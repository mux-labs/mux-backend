import { RateLimitService } from './rate-limit.service';

describe('RateLimitService', () => {
  describe('ms (max tracked developers)', () => {
    it('never tracks more than `ms` distinct developers under a flood of ids', () => {
      const service = new RateLimitService();
      const cap = (service as unknown as { ms: number }).ms;
      const windows = (service as unknown as { windows: Map<string, unknown> })
        .windows;

      expect(typeof cap).toBe('number');
      expect(cap).toBeGreaterThan(0);

      for (let i = 0; i < cap * 3; i++) {
        service.consume(`dev-${i}`);
        expect(windows.size).toBeLessThanOrEqual(cap);
      }

      expect(windows.size).toBe(cap);
    });

    it('evicts the least-recently-seen entry at the cap', () => {
      const service = new RateLimitService();
      const cap = (service as unknown as { ms: number }).ms;
      const windows = (service as unknown as { windows: Map<string, unknown> })
        .windows;

      // Fill to the cap with distinct ids.
      for (let i = 0; i < cap; i++) {
        service.consume(`dev-${i}`);
      }
      expect(windows.size).toBe(cap);
      expect(windows.has('dev-0')).toBe(true);

      // One more distinct id must evict the oldest (dev-0).
      service.consume('dev-overflow');

      expect(windows.size).toBe(cap);
      expect(windows.has('dev-0')).toBe(false);
      expect(windows.has('dev-overflow')).toBe(true);
    });

    it('gives an evicted developer a fresh (empty) window rather than a denial', () => {
      const service = new RateLimitService();
      const cap = (service as unknown as { ms: number }).ms;

      // Exhaust dev-0's window so a denial would be observable.
      const limit = (service as unknown as { limit: number }).limit;
      for (let i = 0; i < limit; i++) {
        service.consume('dev-0');
      }

      // Flood with distinct ids to evict dev-0.
      for (let i = 0; i < cap; i++) {
        service.consume(`flood-${i}`);
      }

      // dev-0 was evicted; its next request starts a fresh window and is allowed.
      const result = service.consume('dev-0');
      expect(result.allowed).toBe(true);
    });
  });
});
