import {
  backoffDelayMs,
  DEFAULT_RPC_BACKOFF_MS,
  DEFAULT_RPC_DEADLINE_MS,
  DEFAULT_RPC_MAX_ATTEMPTS,
  isAbortError,
  isTransientRpcError,
  MAX_RPC_ATTEMPTS,
  MAX_RPC_BACKOFF_MS,
  PERMANENT_ERROR_NAMES,
  resolveSorobanRpcRetryPolicy,
  SorobanRpcRetryErrorCode,
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

/** A transport-level error whose name is in TRANSIENT_ERROR_NAMES. */
const transportBlip = (): Error =>
  Object.assign(new Error('socket hang up'), { name: 'ECONNRESET' });

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

    it('defaults retrySubmit to false when SOROBAN_RPC_RETRY_SUBMIT is unset', () => {
      delete process.env.SOROBAN_RPC_RETRY_SUBMIT;
      expect(resolveSorobanRpcRetryPolicy(process.env).retrySubmit).toBe(false);
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

    it('clamps an oversized maxAttempts to MAX_RPC_ATTEMPTS', () => {
      expect(
        resolveSorobanRpcRetryPolicy({
          SOROBAN_RPC_MAX_ATTEMPTS: String(MAX_RPC_ATTEMPTS + 1),
        }).maxAttempts,
      ).toBe(MAX_RPC_ATTEMPTS);
      expect(
        resolveSorobanRpcRetryPolicy({
          SOROBAN_RPC_MAX_ATTEMPTS: '1000000',
        }).maxAttempts,
      ).toBe(MAX_RPC_ATTEMPTS);
    });

    it('never resolves maxAttempts below 1', () => {
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_MAX_ATTEMPTS: '0' })
          .maxAttempts,
      ).toBeGreaterThanOrEqual(1);
      expect(
        resolveSorobanRpcRetryPolicy({ SOROBAN_RPC_MAX_ATTEMPTS: '-100' })
          .maxAttempts,
      ).toBeGreaterThanOrEqual(1);
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

    it('clamps an oversized backoffMs to MAX_RPC_BACKOFF_MS', () => {
      expect(
        resolveSorobanRpcRetryPolicy({
          SOROBAN_RPC_RETRY_BACKOFF_MS: String(MAX_RPC_BACKOFF_MS + 1),
        }).backoffMs,
      ).toBe(MAX_RPC_BACKOFF_MS);
      expect(
        resolveSorobanRpcRetryPolicy({
          SOROBAN_RPC_RETRY_BACKOFF_MS: '100000000',
        }).backoffMs,
      ).toBe(MAX_RPC_BACKOFF_MS);
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

    it('sets retrySubmit to true only for an explicit truthy SOROBAN_RPC_RETRY_SUBMIT', () => {
      process.env.SOROBAN_RPC_RETRY_SUBMIT = 'true';
      expect(resolveSorobanRpcRetryPolicy(process.env).retrySubmit).toBe(true);

      for (const falsy of ['', 'false', '0', 'no', 'off']) {
        process.env.SOROBAN_RPC_RETRY_SUBMIT = falsy;
        expect(resolveSorobanRpcRetryPolicy(process.env).retrySubmit).toBe(
          false,
        );
      }
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

    it('attempts a permanent error exactly once and never retries it', async () => {
      const { delays, sleep } = fakeSleep();
      const permanentName = PERMANENT_ERROR_NAMES[0] ?? 'ValidationError';
      const err = Object.assign(new Error('permanent'), {
        name: permanentName,
      });
      const fn = jest.fn().mockRejectedValue(err);

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
      expect(result).toMatchObject({ outcome: 'failure', attempts: 1 });
    });

    it('attempts a non-429 4xx status exactly once', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(permanent());

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
      expect(result).toMatchObject({ outcome: 'failure', attempts: 1 });
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

      expect(fn).toHaveBeenCalledTimes(2);
      expect(delays).toHaveLength(1);
      expect(result).toMatchObject({ outcome: 'success', attempts: 2 });
    });

    it('retries a transport-level blip', async () => {
      const { sleep } = fakeSleep();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(transportBlip())
        .mockResolvedValueOnce('ok');

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(fn).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ outcome: 'success', attempts: 2 });
    });

    it('gives up after maxAttempts transient failures', async () => {
      const { sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(transient());

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(fn).toHaveBeenCalledTimes(POLICY.maxAttempts);
      expect(result).toMatchObject({
        outcome: 'failure',
        attempts: POLICY.maxAttempts,
      });
    });

    it('does not retry when retryable is false', async () => {
      const { delays, sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(transient());

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: false,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
      expect(result).toMatchObject({ outcome: 'failure', attempts: 1 });
    });

    it('stops retrying once the deadline is exceeded', async () => {
      const { sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(transient());
      const now = jest
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValue(1_000_000);

      const result = await withSorobanRpcRetry(fn, {
        policy: { ...POLICY, deadlineMs: 1 },
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
        now,
      });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ outcome: 'failure', attempts: 1 });
    });

    it('surfaces the error code on a permanent failure', async () => {
      const { sleep } = fakeSleep();
      const fn = jest.fn().mockRejectedValue(permanent());

      const result = await withSorobanRpcRetry(fn, {
        policy: POLICY,
        retryable: true,
        operation: 'simulate',
        sleep,
        random: () => 1,
      });

      expect(result.outcome).toBe('failure');
      if (result.outcome === 'failure') {
        expect(result.code).toBe(SorobanRpcRetryErrorCode.Permanent);
      }
    });
  });
});
