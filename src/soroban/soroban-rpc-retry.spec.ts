import {
  backoffDelayMs,
  DEFAULT_RPC_BACKOFF_MS,
  DEFAULT_RPC_DEADLINE_MS,
  DEFAULT_RPC_MAX_ATTEMPTS,
  isAbortError,
  isTransientRpcError,
  MAX_RPC_ATTEMPTS,
  MAX_RPC_BACKOFF_MS,
  resolveSorobanRpcRetryPolicy,
  statusCodeOf,
  withSorobanRpcRetry,
} from './soroban-rpc-retry';
import type { SorobanRpcRetryPolicy } from './soroban-rpc-retry';

const POLICY: SorobanRpcRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 100,
  deadlineMs: 10_000,
  retrySubmit: false,
};

/** An error shaped like a transient HTTP 503 from an RPC client. */
const transient = (status = 503): Error =>
  Object.assign(new Error('service unavailable'), { statusCode: status });

/** An error shaped like a permanent HTTP 400. */
const permanent = (): Error =>
  Object.assign(new Error('bad request'), { statusCode: 400 });

describe('Soroban RPC retry policy (#953)', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('resolveSorobanRpcRetryPolicy()', () => {
    it('returns the documented defaults when nothing is set', () => {
      expect(resolveSorobanRpcRetryPolicy({})).toEqual({
        maxAttempts: DEFAULT_RPC_MAX_ATTEMPTS,
        backoffMs: DEFAULT_RPC_BACKOFF_MS,
        deadlineMs: DEFAULT_RPC_DEADLINE_MS,
        retrySubmit: false,
      });
    });

    it('defaults submit retries to off (deny-by-default on a money path)', () => {
      expect(resolveSorobanRpcRetryPolicy({}).retrySubmit).toBe(false);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_RETRY_SUBMIT: '' })
          .retrySubmit,
      ).toBe(false);
    });

    it('clamps a nonsensical attempt count rather than trusting it', () => {
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_MAX_ATTEMPTS: '0' })
          .maxAttempts,
      ).toBe(1);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_MAX_ATTEMPTS: '-5' })
          .maxAttempts,
      ).toBe(1);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_MAX_ATTEMPTS: '99999' })
          .maxAttempts,
      ).toBe(MAX_RPC_ATTEMPTS);
    });

    it('falls back to the default for a non-integer value', () => {
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_MAX_ATTEMPTS: 'abc' })
          .maxAttempts,
      ).toBe(DEFAULT_RPC_MAX_ATTEMPTS);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_MAX_ATTEMPTS: '2.5' })
          .maxAttempts,
      ).toBe(DEFAULT_RPC_MAX_ATTEMPTS);
    });

    it('clamps the backoff ceiling', () => {
      expect(
        resolveSorobanRpcRetryPolicy({
          SOROBAN_RPC_RETRY_BACKOFF_MS: '9999999',
        }).backoffMs,
      ).toBe(MAX_RPC_BACKOFF_MS);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_RETRY_BACKOFF_MS: '-1' })
          .backoffMs,
      ).toBe(0);
    });

    it('only opts into submit retries on an explicit truthy value', () => {
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_RETRY_SUBMIT: 'true' })
          .retrySubmit,
      ).toBe(true);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_RETRY_SUBMIT: 'no' })
          .retrySubmit,
      ).toBe(false);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_RETRY_SUBMIT: 'maybe' })
          .retrySubmit,
      ).toBe(false);
    });
  });

  describe('isTransientRpcError()', () => {
    it('retries transient status codes', () => {
      for (const status of [408, 425, 429, 500, 502, 503, 504]) {
        expect(isTransientRpcError(transient(status))).toBe(true);
      }
    });

    it('does not retry permanent status codes', () => {
      for (const status of [400, 401, 403, 404, 409, 422]) {
        expect(isTransientRpcError(transient(status))).toBe(false);
      }
    });

    it('does not retry an unknown error (fail closed against a retry storm)', () => {
      expect(isTransientRpcError(new Error('something odd'))).toBe(false);
    });

    it('retries transport-level error names and codes', () => {
      for (const name of [
        'ECONNRESET',
        'ETIMEDOUT',
        'SocketError',
        'NetworkError',
      ]) {
        const err = Object.assign(new Error('blip'), { name, code: name });
        expect(isTransientRpcError(err)).toBe(true);
      }
    });

    it('does not retry known permanent error names', () => {
      for (const name of ['BadRequestError', 'ContractError', 'SdkError']) {
        const err = Object.assign(new Error('nope'), { name });
        expect(isTransientRpcError(err)).toBe(false);
      }
    });

    it('never treats an abort as transient', () => {
      const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
      expect(isAbortError(err)).toBe(true);
      expect(isTransientRpcError(err)).toBe(false);
    });
  });

  describe('statusCodeOf()', () => {
    it('reads the several shapes RPC clients use', () => {
      expect(statusCodeOf({ statusCode: 503 })).toBe(503);
      expect(statusCodeOf({ status: 429 })).toBe(429);
      expect(statusCodeOf({ response: { status: 500 } })).toBe(500);
      expect(statusCodeOf({ code: 502 })).toBe(502);
      expect(statusCodeOf(new Error('plain'))).toBeUndefined();
      expect(statusCodeOf(null)).toBeUndefined();
    });
  });
  describe('backoffDelayMs()', () => {
    it('is bounded by the exponential term for the attempt', () => {
      // random() === 1 selects the top of the jitter range.
      expect(backoffDelayMs(1, POLICY, () => 1)).toBe(100);
      expect(backoffDelayMs(2, POLICY, () => 1)).toBe(200);
      expect(backoffDelayMs(3, POLICY, () => 1)).toBe(400);
    });

    it('applies full jitter, so the delay can be anywhere in [0, cap]', () => {
      expect(backoffDelayMs(1, POLICY, () => 0)).toBe(0);
      expect(backoffDelayMs(1, POLICY, () => 0.5)).toBe(50);
    });

    it('caps the growth so a long chain cannot produce an unbounded delay', () => {
      const longChain: SorobanRpcRetryPolicy = { ...POLICY, backoffMs: 5_000 };
      expect(backoffDelayMs(20, longChain, () => 1)).toBe(MAX_RPC_BACKOFF_MS);
    });
  });
  describe('withSorobanRpcRetry()', () => {
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

    it('returns immediately on the first success without sleeping', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest.fn().mockResolvedValue('ok');

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(result).toMatchObject({
        outcome: 'success',
        attempts: 1,
        value: 'ok',
      });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('retries a transient failure and succeeds', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(transient())
        .mockResolvedValueOnce('ok');

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(result).toMatchObject({
        outcome: 'success',
        attempts: 2,
        value: 'ok',
      });
      expect(delays).toEqual([100]);
    });

    it('does NOT retry a permanent failure', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(permanent());

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(result.outcome).toBe('exhausted');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });
    it('stops at the attempt bound when every attempt is transient', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(transient());

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(result.outcome).toBe('exhausted');
      expect(fn).toHaveBeenCalledTimes(POLICY.maxAttempts);
      expect(delays).toHaveLength(POLICY.maxAttempts - 1);
    });

    it('makes exactly one attempt when the call is not retryable (submit)', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(transient());

      const result = await withSorobanRpcRetry(fn, {
        policy: { ...POLICY, maxAttempts: 5, retrySubmit: false },
        retryable: false,
        operation: 'submit',
        sleep,
        random: () => 1,
      });

      // This is the duplicate-submission guard: a lost submit response must not
      // be blindly re-sent, because the transaction may have landed.
      expect(result.outcome).toBe('exhausted');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('retries a submit only when the operator opts in', async () => {
      const { sleep } = fakeSleep();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(transient())
        .mockResolvedValueOnce({ transactionHash: 'hash' });

      const result = await withSorobanRpcRetry(fn, {
        policy: { ...POLICY, retrySubmit: true },
        retryable: true,
        operation: 'submit',
        sleep,
        random: () => 1,
      });

      expect(result).toMatchObject({ outcome: 'success', attempts: 2 });
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('stops when the next attempt would exceed the deadline', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(transient());

      // The deadline is smaller than the first backoff, so there is no budget
      // for a second attempt.
      const result = await withSorobanRpcRetry(fn, {
        policy: { ...POLICY, deadlineMs: 50 },
        retryable: true,
        operation: 'simulate',
        sleep,
        now: () => 0,
        random: () => 1,
      });

      expect(result.outcome).toBe('exhausted');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });

    it('reports an aborted call rather than retrying it', async () => {
      const { sleep } = fakeSleep();
      const controller = new AbortController();
      const fn = jest.fn().mockImplementation(() => {
        controller.abort();
        throw transient();
      });

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        signal: controller.signal,
        sleep,
        random: () => 1,
      });

      expect(result.outcome).toBe('aborted');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not start at all when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const fn = jest.fn();

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        signal: controller.signal,
      });

      expect(result.outcome).toBe('aborted');
      expect(fn).not.toHaveBeenCalled();
    });

    it('reports each retry through the observability hook', async () => {
      const { sleep } = fakeSleep();
      const onRetry = jest.fn();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(transient())
        .mockResolvedValueOnce('ok');

      await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        onRetry,
        random: () => 1,
      });

      expect(onRetry).toHaveBeenCalledWith({
        operation: 'simulate',
        attempt: 1,
        delayMs: 100,
      });
    });

    it('never throws for an RPC failure, so the caller keeps classification', async () => {
      const err = transient();

      await expect(
        withSorobanRpcRetry(() => Promise.reject(err), {
          policy: { ...POLICY, maxAttempts: 1 },
          retryable: true,
          operation: 'simulate',
          sleep: () => Promise.resolve(),
        }),
      ).resolves.toMatchObject({ outcome: 'exhausted', error: err });
    });

    it('respects maxAttempts = 1 (retries disabled)', async () => {
      const fn = jest.fn().mockRejectedValue(transient());

      const result = await withSorobanRpcRetry(fn, {
        policy: { ...POLICY, maxAttempts: 1 },
        retryable: true,
        operation: 'simulate',
        sleep: () => Promise.resolve(),
      });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe('exhausted');
    });
  });
});
