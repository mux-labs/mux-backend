import { Set } from './horizon-retry.policy';

describe('horizon-retry.policy Set', () => {
  it('contains transport-level error codes that are safe to retry on an idempotent read', () => {
    expect(Set).toBeInstanceOf(Set);
    expect(Set.size).toBeGreaterThan(0);
  });

  it('includes the transport-level error codes named as retryable', () => {
    // Transport-level failures (connection reset, timeout, DNS, etc.) are
    // safe to retry on an idempotent read.
    expect(Set.has('ECONNRESET')).toBe(true);
    expect(Set.has('ETIMEDOUT')).toBe(true);
    expect(Set.has('ECONNREFUSED')).toBe(true);
    expect(Set.has('ENOTFOUND')).toBe(true);
    expect(Set.has('EAI_AGAIN')).toBe(true);
  });

  it('does not include non-transport error codes (failure path)', () => {
    // Application-level / non-transport errors must not be retried.
    expect(Set.has('400')).toBe(false);
    expect(Set.has('404')).toBe(false);
    expect(Set.has('500')).toBe(false);
    expect(Set.has('UNKNOWN')).toBe(false);
  });
});
