import { WalletRetryService } from './wallet-retry.service';

const makeConfig = (overrides: Record<string, number> = {}) => ({
  get: jest.fn((key: string, fallback: number) => overrides[key] ?? fallback),
});

describe('WalletRetryService', () => {
  let service: WalletRetryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WalletRetryService(makeConfig() as any);
    jest.spyOn(service as any, 'wait').mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it('returns immediately when the operation succeeds on the first attempt', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(
      service.execute({ operation: 'key_generation' }, operation),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  it('retries transient dependency failures with exponential backoff', async () => {
    const transient = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('key-material');

    await expect(
      service.execute({ operation: 'key_generation' }, operation),
    ).resolves.toBe('key-material');

    expect(operation).toHaveBeenCalledTimes(3);
    expect((service as any).wait).toHaveBeenNthCalledWith(1, 100);
    expect((service as any).wait).toHaveBeenNthCalledWith(2, 200);
  });

  // -----------------------------------------------------------------------
  // maxAttempts override
  // -----------------------------------------------------------------------

  it('respects maxAttempts=1 (no retries at all)', async () => {
    const transient = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const operation = jest.fn().mockRejectedValue(transient);

    await expect(
      service.execute({ operation: 'op', maxAttempts: 1 }, operation),
    ).rejects.toBe(transient);

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  it('clamps maxAttempts below 1 to 1 (treats 0 as a single attempt)', async () => {
    const transient = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const operation = jest.fn().mockRejectedValue(transient);

    await expect(
      service.execute({ operation: 'op', maxAttempts: 0 }, operation),
    ).rejects.toBe(transient);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('overrides default maxAttempts when provided', async () => {
    const transient = Object.assign(new Error('conn'), { code: 'ECONNRESET' });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('done');

    await expect(
      service.execute({ operation: 'op', maxAttempts: 2 }, operation),
    ).resolves.toBe('done');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Backoff cap
  // -----------------------------------------------------------------------

  it('caps delay at maxDelayMs', async () => {
    const capped = new WalletRetryService(
      makeConfig({
        WALLET_API_RETRY_MAX_ATTEMPTS: 5,
        WALLET_API_RETRY_BASE_DELAY_MS: 1000,
        WALLET_API_RETRY_MAX_DELAY_MS: 2000,
      }) as any,
    );
    jest.spyOn(capped as any, 'wait').mockResolvedValue(undefined);

    const transient = Object.assign(new Error('t'), { code: 'ECONNRESET' });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transient) // delay = min(1000*2^0, 2000) = 1000
      .mockRejectedValueOnce(transient) // delay = min(1000*2^1, 2000) = 2000
      .mockRejectedValueOnce(transient) // delay = min(1000*2^2, 2000) = 2000 (capped)
      .mockRejectedValueOnce(transient) // delay = min(1000*2^3, 2000) = 2000 (capped)
      .mockResolvedValueOnce('ok');

    await expect(
      capped.execute({ operation: 'op' }, operation),
    ).resolves.toBe('ok');

    expect((capped as any).wait).toHaveBeenNthCalledWith(1, 1000);
    expect((capped as any).wait).toHaveBeenNthCalledWith(2, 2000);
    expect((capped as any).wait).toHaveBeenNthCalledWith(3, 2000);
    expect((capped as any).wait).toHaveBeenNthCalledWith(4, 2000);
  });

  // -----------------------------------------------------------------------
  // isTransient: HTTP status codes
  // -----------------------------------------------------------------------

  it('does not retry non-transient HTTP 4xx failures (400)', async () => {
    const invalidRequest = Object.assign(new Error('invalid key request'), {
      status: 400,
    });
    const operation = jest.fn().mockRejectedValue(invalidRequest);

    await expect(
      service.execute({ operation: 'key_generation' }, operation),
    ).rejects.toBe(invalidRequest);

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  it('does not retry non-transient HTTP 4xx failures (401, 403, 404)', async () => {
    for (const status of [401, 403, 404]) {
      jest.clearAllMocks();
      service = new WalletRetryService(makeConfig() as any);
      jest.spyOn(service as any, 'wait').mockResolvedValue(undefined);

      const err = Object.assign(new Error('client error'), { status });
      const operation = jest.fn().mockRejectedValue(err);

      await expect(
        service.execute({ operation: 'op' }, operation),
      ).rejects.toBe(err);

      expect(operation).toHaveBeenCalledTimes(1);
    }
  });

  it('retries HTTP 408 (Request Timeout)', async () => {
    const err = Object.assign(new Error('timeout'), { status: 408 });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    await expect(
      service.execute({ operation: 'op' }, operation),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries HTTP 425 (Too Early)', async () => {
    const err = Object.assign(new Error('too early'), { status: 425 });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    await expect(
      service.execute({ operation: 'op' }, operation),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries HTTP 429 (Rate Limited)', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    await expect(
      service.execute({ operation: 'op' }, operation),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries HTTP 5xx server errors', async () => {
    for (const status of [500, 502, 503, 504]) {
      jest.clearAllMocks();
      service = new WalletRetryService(makeConfig() as any);
      jest.spyOn(service as any, 'wait').mockResolvedValue(undefined);

      const err = Object.assign(new Error('server error'), { status });
      const operation = jest
        .fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce('ok');

      await expect(
        service.execute({ operation: 'op' }, operation),
      ).resolves.toBe('ok');

      expect(operation).toHaveBeenCalledTimes(2);
    }
  });

  it('reads status from error.response.status when error.status is absent', async () => {
    const err = { response: { status: 503 }, message: 'service unavailable' };
    const operation = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    await expect(
      service.execute({ operation: 'op' }, operation),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // isTransient: network error codes
  // -----------------------------------------------------------------------

  it.each([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('retries network error code %s', async (code) => {
    jest.clearAllMocks();
    service = new WalletRetryService(makeConfig() as any);
    jest.spyOn(service as any, 'wait').mockResolvedValue(undefined);

    const err = Object.assign(new Error('network'), { code });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    await expect(
      service.execute({ operation: 'op' }, operation),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Non-retriable: AbortError
  // -----------------------------------------------------------------------

  it('does not retry AbortError even though it is a network-level failure', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const operation = jest.fn().mockRejectedValue(abortErr);

    await expect(
      service.execute({ operation: 'op' }, operation),
    ).rejects.toBe(abortErr);

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Exhaustion: all attempts fail with transient errors
  // -----------------------------------------------------------------------

  it('throws the last transient error after all attempts are exhausted', async () => {
    const transient = Object.assign(new Error('always fails'), {
      code: 'ECONNRESET',
    });
    const operation = jest.fn().mockRejectedValue(transient);

    await expect(
      service.execute({ operation: 'key_generation' }, operation),
    ).rejects.toBe(transient);

    expect(operation).toHaveBeenCalledTimes(3); // default maxAttempts=3
    expect((service as any).wait).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Config overrides are read from ConfigService
  // -----------------------------------------------------------------------

  it('reads maxAttempts from config env WALLET_API_RETRY_MAX_ATTEMPTS', async () => {
    const configuredService = new WalletRetryService(
      makeConfig({ WALLET_API_RETRY_MAX_ATTEMPTS: 2 }) as any,
    );
    jest.spyOn(configuredService as any, 'wait').mockResolvedValue(undefined);

    const transient = Object.assign(new Error('t'), { code: 'ETIMEDOUT' });
    const operation = jest.fn().mockRejectedValue(transient);

    await expect(
      configuredService.execute({ operation: 'op' }, operation),
    ).rejects.toBe(transient);

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('reads baseDelayMs from config env WALLET_API_RETRY_BASE_DELAY_MS', async () => {
    const configuredService = new WalletRetryService(
      makeConfig({ WALLET_API_RETRY_BASE_DELAY_MS: 50 }) as any,
    );
    jest.spyOn(configuredService as any, 'wait').mockResolvedValue(undefined);

    const transient = Object.assign(new Error('t'), { code: 'ECONNRESET' });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('ok');

    await configuredService.execute({ operation: 'op' }, operation);

    expect((configuredService as any).wait).toHaveBeenCalledWith(50);
  });
});
