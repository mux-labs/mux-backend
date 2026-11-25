import { index, resolveIntervalMs } from './idempotency-cleanup.worker';

describe('idempotency-cleanup.worker index', () => {
  it('is the largest delay setInterval accepts (2^31 - 1 ms)', () => {
    expect(index).toBe(2 ** 31 - 1);
    expect(index).toBe(2147483647);
  });

  it('is the maximum safe interval delay before overflow', () => {
    // Values larger than index overflow the 32-bit signed timer and Node
    // fires the callback immediately, which would turn the prune into a hot
    // loop. index must therefore be the largest value that does not overflow.
    expect(index).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(index + 1).toBeGreaterThan(2 ** 31 - 1);
  });
});

describe('resolveIntervalMs', () => {
  const DEFAULT_INTERVAL_MS = 60_000;

  it('returns a finite, positive delay within setInterval range for valid input', () => {
    const result = resolveIntervalMs(5_000);
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(index);
    expect(result).toBe(5_000);
  });

  it('accepts the largest in-range delay', () => {
    const result = resolveIntervalMs(index);
    expect(result).toBe(index);
    expect(result).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('falls back to the default for non-finite values', () => {
    expect(resolveIntervalMs(NaN)).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs(Infinity)).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs(-Infinity)).toBe(DEFAULT_INTERVAL_MS);
  });

  it('falls back to the default for non-positive values', () => {
    expect(resolveIntervalMs(0)).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs(-1)).toBe(DEFAULT_INTERVAL_MS);
  });

  it('falls back to the default for out-of-range values', () => {
    expect(resolveIntervalMs(index + 1)).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs(2 ** 31)).toBe(DEFAULT_INTERVAL_MS);
  });
});
