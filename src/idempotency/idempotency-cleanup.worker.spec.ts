import { index } from './idempotency-cleanup.worker';

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
