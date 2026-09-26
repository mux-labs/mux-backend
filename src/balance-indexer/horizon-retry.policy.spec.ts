import {
  DEFAULT_HORIZON_MAX_RETRIES,
  DEFAULT_HORIZON_RETRY_BACKOFF_MS,
  DEFAULT_HORIZON_RETRY_BUDGET_MS,
  DEFAULT_HORIZON_RETRY_JITTER_MS,
  HORIZON_RETRY_ENV,
  HorizonRetryExhaustedError,
  MAX_HORIZON_RETRIES,
  horizonRetryAfterMs,
  isRetryableHorizonError,
  isRetryableHorizonStatus,
  parseRetryAfterMs,
  resolveHorizonRetryConfig,
  runWithHorizonRetry,
} from './horizon-retry.policy';

/** Build an axios-shaped error with a response. */
function httpError(status: number, headers: Record<string, unknown> = {}) {
  return Object.assign(new Error(`status ${status}`), {
    isAxiosError: true,
    response: { status, headers },
  });
}

/** Build an axios-shaped transport error (no response). */
function transportError(code: string) {
  return Object.assign(new Error(code), { isAxiosError: true, code });
}

const NO_DELAY = {
  maxRetries: 3,
  backoffMs: 0,
  jitterMs: 0,
  budgetMs: DEFAULT_HORIZON_RETRY_BUDGET_MS,
};

describe('resolveHorizonRetryConfig', () => {
  it('uses documented defaults when unset', () => {
    const config = resolveHorizonRetryConfig({});
    expect(config).toEqual({
      maxRetries: DEFAULT_HORIZON_MAX_RETRIES,
      backoffMs: DEFAULT_HORIZON_RETRY_BACKOFF_MS,
      jitterMs: DEFAULT_HORIZON_RETRY_JITTER_MS,
      budgetMs: DEFAULT_HORIZON_RETRY_BUDGET_MS,
    });
  });

  it('reads configured values', () => {
    const config = resolveHorizonRetryConfig({
      [HORIZON_RETRY_ENV.MAX_RETRIES]: '5',
      [HORIZON_RETRY_ENV.BACKOFF_MS]: '250',
      [HORIZON_RETRY_ENV.JITTER_MS]: '50',
      [HORIZON_RETRY_ENV.BUDGET_MS]: '2000',
    });
    expect(config).toEqual({
      maxRetries: 5,
      backoffMs: 250,
      jitterMs: 50,
      budgetMs: 2000,
    });
  });

  it('fails closed on malformed values instead of retrying forever', () => {
    const config = resolveHorizonRetryConfig({
      [HORIZON_RETRY_ENV.MAX_RETRIES]: 'not-a-number',
      [HORIZON_RETRY_ENV.BACKOFF_MS]: '-5',
    });
    expect(config.maxRetries).toBe(DEFAULT_HORIZON_MAX_RETRIES);
    expect(config.backoffMs).toBe(DEFAULT_HORIZON_RETRY_BACKOFF_MS);
  });

  it('clamps maxRetries to the hard ceiling', () => {
    const config = resolveHorizonRetryConfig({
      [HORIZON_RETRY_ENV.MAX_RETRIES]: '9999',
    });
    expect(config.maxRetries).toBe(MAX_HORIZON_RETRIES);
  });
});

describe('retry classification', () => {
  it('retries only transient statuses', () => {
    expect(isRetryableHorizonStatus(408)).toBe(true);
    expect(isRetryableHorizonStatus(429)).toBe(true);
    expect(isRetryableHorizonStatus(500)).toBe(true);
    expect(isRetryableHorizonStatus(503)).toBe(true);
    expect(isRetryableHorizonStatus(400)).toBe(false);
    expect(isRetryableHorizonStatus(403)).toBe(false);
    expect(isRetryableHorizonStatus(404)).toBe(false);
  });

  it('retries transport failures but not permanent 4xx', () => {
    expect(isRetryableHorizonError(transportError('ECONNRESET'))).toBe(true);
    expect(isRetryableHorizonError(transportError('ETIMEDOUT'))).toBe(true);
    expect(isRetryableHorizonError(httpError(503))).toBe(true);
    expect(isRetryableHorizonError(httpError(404))).toBe(false);
    expect(isRetryableHorizonError(httpError(400))).toBe(false);
  });

  it('treats unknown error shapes as permanent (deny-by-default)', () => {
    expect(isRetryableHorizonError(new Error('boom'))).toBe(false);
    expect(isRetryableHorizonError(undefined)).toBe(false);
    expect(isRetryableHorizonError('nope')).toBe(false);
  });
});

describe('Retry-After parsing', () => {
  it('parses seconds and HTTP dates', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('2', now)).toBe(2000);
    expect(parseRetryAfterMs('2026-01-01T00:00:05Z', now)).toBe(5000);
  });

  it('returns undefined for absent/unparseable values', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('garbage')).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
  });

  it('extracts the header from an axios error', () => {
    expect(horizonRetryAfterMs(httpError(429, { 'retry-after': '3' }))).toBe(
      3000,
    );
    expect(horizonRetryAfterMs(httpError(429))).toBeUndefined();
  });
});

describe('runWithHorizonRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const operation = jest.fn().mockResolvedValue('ok');
    const sleep = jest.fn();

    await expect(
      runWithHorizonRetry(operation, { config: NO_DELAY, sleep }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries transient failures and succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue('recovered');
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(
      runWithHorizonRetry(operation, { config: NO_DELAY, sleep }),
    ).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a typed error when the budget is exhausted', async () => {
    const operation = jest.fn().mockRejectedValue(httpError(503));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const config = { ...NO_DELAY, maxRetries: 2 };

    await expect(
      runWithHorizonRetry(operation, { config, sleep }),
    ).rejects.toMatchObject({
      name: 'HorizonRetryExhaustedError',
      attempts: 3,
      reason: 'http_503',
    });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries permanent failures', async () => {
    const operation = jest.fn().mockRejectedValue(httpError(404));
    const sleep = jest.fn();

    await expect(
      runWithHorizonRetry(operation, { config: NO_DELAY, sleep }),
    ).rejects.toThrow('status 404');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses exponential backoff and honours Retry-After', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '7' }))
      .mockResolvedValue('ok');
    const sleep = jest.fn().mockResolvedValue(undefined);

    await runWithHorizonRetry(operation, {
      config: { maxRetries: 3, backoffMs: 100, jitterMs: 0, budgetMs: 60_000 },
      sleep,
    });

    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 7000);
  });

  it('caps the total delay with the wall-clock budget', async () => {
    const operation = jest.fn().mockRejectedValue(httpError(503));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(
      runWithHorizonRetry(operation, {
        config: {
          maxRetries: 5,
          backoffMs: 100,
          jitterMs: 50,
          budgetMs: 150,
        },
        sleep,
        random: () => 0,
      }),
    ).rejects.toBeInstanceOf(HorizonRetryExhaustedError);

    // First retry (100ms) fits the 150ms budget; the second (200ms) would not.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('emits secret-free retry/exhausted observations', async () => {
    const operation = jest.fn().mockRejectedValue(httpError(503));
    const onRetry = jest.fn();
    const onExhausted = jest.fn();

    await expect(
      runWithHorizonRetry(operation, {
        config: { ...NO_DELAY, maxRetries: 1 },
        sleep: jest.fn().mockResolvedValue(undefined),
        observer: { onRetry, onExhausted },
      }),
    ).rejects.toBeInstanceOf(HorizonRetryExhaustedError);

    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      delayMs: 0,
      reason: 'http_503',
    });
    expect(onExhausted).toHaveBeenCalledWith({
      attempts: 2,
      reason: 'http_503',
    });
  });
});
