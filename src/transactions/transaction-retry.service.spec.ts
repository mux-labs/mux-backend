import { TransactionRetryService } from './transaction-retry.service';

describe('TransactionRetryService', () => {
  const config = {
    get: jest.fn((_key: string, fallback: number) => fallback),
  };
  let service: TransactionRetryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TransactionRetryService(config as any);
    jest.spyOn(service as any, 'wait').mockResolvedValue(undefined);
  });

  it('returns the result immediately when the operation succeeds on the first attempt', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(
      service.execute({ operation: 'submission' }, operation),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  it('retries transient Horizon 5xx failures with exponential backoff', async () => {
    const serverError = Object.assign(new Error('server error'), {
      response: { status: 503 },
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce('submitted');

    await expect(
      service.execute({ operation: 'submission' }, operation),
    ).resolves.toBe('submitted');

    expect(operation).toHaveBeenCalledTimes(3);
    expect((service as any).wait).toHaveBeenNthCalledWith(1, 100);
    expect((service as any).wait).toHaveBeenNthCalledWith(2, 200);
  });

  it('retries transient network connection errors', async () => {
    const connError = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(connError)
      .mockResolvedValueOnce('submitted');

    await expect(
      service.execute({ operation: 'submission' }, operation),
    ).resolves.toBe('submitted');

    expect(operation).toHaveBeenCalledTimes(2);
    expect((service as any).wait).toHaveBeenCalledTimes(1);
  });

  it('does not retry 4xx Horizon rejections', async () => {
    const rejection = Object.assign(new Error('bad sequence'), {
      response: { status: 400 },
    });
    const operation = jest.fn().mockRejectedValue(rejection);

    await expect(
      service.execute({ operation: 'submission' }, operation),
    ).rejects.toBe(rejection);

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  it('does not retry AbortError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const operation = jest.fn().mockRejectedValue(abort);

    await expect(
      service.execute({ operation: 'submission' }, operation),
    ).rejects.toBe(abort);

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  it('throws after exhausting all retry attempts', async () => {
    const transient = Object.assign(new Error('timeout'), {
      code: 'ETIMEDOUT',
    });
    const operation = jest.fn().mockRejectedValue(transient);

    await expect(
      service.execute({ operation: 'submission' }, operation),
    ).rejects.toBe(transient);

    expect(operation).toHaveBeenCalledTimes(3); // default maxAttempts = 3
    expect((service as any).wait).toHaveBeenCalledTimes(2);
  });

  it('respects per-call maxAttempts override', async () => {
    const transient = Object.assign(new Error('net error'), {
      code: 'ECONNREFUSED',
    });
    const operation = jest.fn().mockRejectedValue(transient);

    await expect(
      service.execute({ operation: 'submission', maxAttempts: 1 }, operation),
    ).rejects.toBe(transient);

    expect(operation).toHaveBeenCalledTimes(1);
    expect((service as any).wait).not.toHaveBeenCalled();
  });

  it('caps backoff delay at maxDelayMs', async () => {
    // Use a short maxDelayMs via custom config
    const shortMaxConfig = {
      get: jest.fn((key: string, fallback: number) => {
        if (key === 'TRANSACTION_RETRY_MAX_DELAY_MS') return 150;
        return fallback;
      }),
    };
    const svc = new TransactionRetryService(shortMaxConfig as any);
    jest.spyOn(svc as any, 'wait').mockResolvedValue(undefined);

    const transient = Object.assign(new Error('net error'), {
      code: 'ECONNRESET',
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('done');

    await svc.execute({ operation: 'submission' }, operation);

    // attempt 1: delay = min(100 * 2^0, 150) = 100
    // attempt 2: delay = min(100 * 2^1, 150) = 150 (capped)
    expect((svc as any).wait).toHaveBeenNthCalledWith(1, 100);
    expect((svc as any).wait).toHaveBeenNthCalledWith(2, 150);
  });
});
