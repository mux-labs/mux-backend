import { Set, runWithHorizonRetry } from './horizon-retry.policy';

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

describe('horizon-retry.policy runWithHorizonRetry', () => {
  it('returns the result of an idempotent read without retrying on success', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(runWithHorizonRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable transport error and eventually succeeds', async () => {
    const retryable = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockResolvedValue('recovered');

    await expect(runWithHorizonRetry(operation)).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-retryable error without retrying (failure path)', async () => {
    const nonRetryable = Object.assign(new Error('bad request'), {
      code: '400',
    });
    const operation = jest.fn().mockRejectedValue(nonRetryable);

    await expect(runWithHorizonRetry(operation)).rejects.toBe(nonRetryable);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after bounded retries and rethrows the last error', async () => {
    const retryable = Object.assign(new Error('timeout'), {
      code: 'ETIMEDOUT',
    });
    const operation = jest.fn().mockRejectedValue(retryable);

    await expect(runWithHorizonRetry(operation)).rejects.toBe(retryable);
    // Bounded: the operation is retried a finite number of times, not forever.
    expect(operation.mock.calls.length).toBeGreaterThan(1);
    expect(operation.mock.calls.length).toBeLessThan(20);
  });
});
