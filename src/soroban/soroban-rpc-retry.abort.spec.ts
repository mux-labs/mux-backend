import { withSorobanRpcRetry } from './soroban-rpc-retry';
import type { SorobanRpcRetryPolicy } from './soroban-rpc-retry';

/**
 * Regression coverage for the `aborted` outcome of the Soroban RPC retry
 * policy (#953, invariant 5): a client that disconnects mid-retry stops the
 * work instead of continuing to hammer an RPC that is already struggling, and
 * an aborted call is never reported as a success.
 */

const POLICY: SorobanRpcRetryPolicy = {
  maxAttempts: 5,
  backoffMs: 100,
  deadlineMs: 60_000,
  retrySubmit: false,
};

/** An error shaped like a transient HTTP 503 from an RPC client. */
const transient = (): Error =>
  Object.assign(new Error('service unavailable'), { statusCode: 503 });

/** Sleep stub that records delays without actually waiting. */
const fakeSleep = () => {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
};

describe('withSorobanRpcRetry() aborted outcome (#953)', () => {
  it('makes no RPC call when the signal is already aborted', async () => {
    const { delays, sleep } = fakeSleep();
    const controller = new AbortController();
    controller.abort();
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withSorobanRpcRetry(fn, {
      policy: POLICY,
      retryable: true,
      operation: 'simulate',
      signal: controller.signal,
      sleep,
      random: () => 1,
    });

    expect(fn).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
    expect(result.outcome).toBe('aborted');
    expect(result.attempts).toBe(0);
    expect(result.value).toBeUndefined();
    expect((result.error as Error).name).toBe('AbortError');
  });

  it('stops retrying a transient failure once the client disconnects', async () => {
    const { delays, sleep } = fakeSleep();
    const controller = new AbortController();
    // The client goes away while the first attempt is in flight, and the RPC
    // then reports a blip that would otherwise be retried.
    const fn = jest.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(transient());
    });

    const result = await withSorobanRpcRetry(fn, {
      policy: POLICY,
      retryable: true,
      operation: 'simulate',
      signal: controller.signal,
      sleep,
      random: () => 1,
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(result).toMatchObject({ outcome: 'aborted', attempts: 1 });
    expect(result.value).toBeUndefined();
  });

  it('treats an AbortError from the RPC as aborted, not as a retryable blip', async () => {
    const { delays, sleep } = fakeSleep();
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const fn = jest.fn().mockRejectedValue(abortErr);

    const result = await withSorobanRpcRetry(fn, {
      policy: POLICY,
      retryable: true,
      operation: 'simulate',
      sleep,
      random: () => 1,
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'aborted',
      attempts: 1,
      error: abortErr,
    });
  });

  it('cuts a backoff sleep short when the client disconnects during it', async () => {
    const controller = new AbortController();
    const fn = jest.fn().mockRejectedValue(transient());

    // Real (default) sleep with a 10s backoff: if the abort listener were not
    // honoured this test would hang until jest's timeout and fail.
    const resultPromise = withSorobanRpcRetry(fn, {
      policy: { ...POLICY, backoffMs: 10_000 },
      retryable: true,
      operation: 'simulate',
      signal: controller.signal,
      random: () => 1,
      onRetry: () => {
        setTimeout(() => controller.abort(), 0);
      },
    });

    const result = await resultPromise;

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'aborted', attempts: 1 });
    expect((result.error as Error).name).toBe('AbortError');
  }, 2_000);

  it('cuts a sleep short when the abort lands just before it begins', async () => {
    const controller = new AbortController();
    const fn = jest.fn().mockRejectedValue(transient());

    const result = await withSorobanRpcRetry(fn, {
      policy: { ...POLICY, backoffMs: 10_000 },
      retryable: true,
      operation: 'simulate',
      signal: controller.signal,
      random: () => 1,
      onRetry: () => controller.abort(),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'aborted', attempts: 1 });
  }, 2_000);

  it('keeps retrying the same failure when no abort happens (control)', async () => {
    const { sleep } = fakeSleep();
    const controller = new AbortController();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce('ok');

    const result = await withSorobanRpcRetry(fn, {
      policy: POLICY,
      retryable: true,
      operation: 'simulate',
      signal: controller.signal,
      sleep,
      random: () => 1,
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ outcome: 'success', attempts: 2 });
  });
});
