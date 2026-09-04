import { retryWithBackoff } from './auth-retry.helper';

describe('retryWithBackoff', () => {
  it('returns the result immediately when the operation succeeds on the first attempt', async () => {
    const operation = jest.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(operation);
    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on a transient Prisma P1001 error and succeeds on the second attempt', async () => {
    const transientError = Object.assign(new Error('DB unreachable'), {
      code: 'P1001',
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('ok');

    const result = await retryWithBackoff(operation, 3, 1);
    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on ECONNREFUSED and succeeds on the third attempt', async () => {
    const transientError = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('success');

    const result = await retryWithBackoff(operation, 3, 1);
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-transient errors without retrying', async () => {
    const permanentError = new Error('Not found');
    const operation = jest.fn().mockRejectedValue(permanentError);

    await expect(retryWithBackoff(operation, 3, 1)).rejects.toThrow('Not found');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all attempts on repeated transient errors', async () => {
    const transientError = Object.assign(new Error('timeout'), { code: 'P1002' });
    const operation = jest.fn().mockRejectedValue(transientError);

    await expect(retryWithBackoff(operation, 3, 1)).rejects.toThrow('timeout');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('respects maxAttempts=2: stops after 2 calls', async () => {
    const transientError = Object.assign(new Error('server closed'), {
      code: 'P1017',
    });
    const operation = jest.fn().mockRejectedValue(transientError);

    await expect(retryWithBackoff(operation, 2, 1)).rejects.toBeDefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('detects P1008 (operations timed out) as transient', async () => {
    const transientError = Object.assign(new Error('ops timed out'), {
      code: 'P1008',
    });
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('done');

    const result = await retryWithBackoff(operation, 3, 1);
    expect(result).toBe('done');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('detects ECONNRESET as transient', async () => {
    const transientError = new Error('read ECONNRESET');
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('recovered');

    const result = await retryWithBackoff(operation, 3, 1);
    expect(result).toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('detects EPIPE as transient', async () => {
    const transientError = new Error('write EPIPE');
    const operation = jest
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValue('ok');

    const result = await retryWithBackoff(operation, 3, 1);
    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry on P2002 (unique constraint — non-transient)', async () => {
    const permanentError = Object.assign(new Error('unique constraint'), {
      code: 'P2002',
    });
    const operation = jest.fn().mockRejectedValue(permanentError);

    await expect(retryWithBackoff(operation, 3, 1)).rejects.toThrow(
      'unique constraint',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
