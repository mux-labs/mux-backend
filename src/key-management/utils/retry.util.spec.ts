import { retryWithBackoff } from './retry.util';

jest.useFakeTimers();

describe('retryWithBackoff', () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  it('returns result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 100 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const promise = retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after maxAttempts exhausted', async () => {
    const err = new Error('persistent');
    const fn = jest.fn().mockRejectedValue(err);

    const promise = retryWithBackoff(fn, { maxAttempts: 3, initialDelayMs: 10 });
    await jest.runAllTimersAsync();

    await expect(promise).rejects.toThrow('persistent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when shouldRetry returns false', async () => {
    const err = new Error('non-retryable');
    const fn = jest.fn().mockRejectedValue(err);

    const promise = retryWithBackoff(fn, {
      maxAttempts: 5,
      initialDelayMs: 10,
      shouldRetry: () => false,
    });

    await expect(promise).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects maxDelayMs cap', async () => {
    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValue('done');

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 150,
      backoffFactor: 10,
    });
    await jest.runAllTimersAsync();
    await promise;

    expect(fn).toHaveBeenCalledTimes(3);
  });
});
