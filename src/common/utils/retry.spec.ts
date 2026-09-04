import { Logger } from '@nestjs/common';
import { retryWithBackoff, RetryError } from './retry';

describe('retryWithBackoff', () => {
  let logger: any;

  beforeEach(() => {
    logger = { debug: jest.fn() };
  });

  it('should return value on first attempt success', async () => {
    const fn = jest.fn().mockResolvedValue('success');

    const result = await retryWithBackoff(fn, 3, 100, logger);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed on second attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce('success');

    const result = await retryWithBackoff(fn, 3, 100, logger);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it('should exhausts all retries and throw last error', async () => {
    const error = new Error('Persistent error');
    const fn = jest.fn().mockRejectedValue(error);

    await expect(retryWithBackoff(fn, 3, 100, logger)).rejects.toThrow(
      'Persistent error',
    );

    expect(fn).toHaveBeenCalledTimes(3);
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 400 client error', async () => {
    const error = new Error('Bad request');
    (error as any).status = 400;
    const fn = jest.fn().mockRejectedValue(error);

    await expect(retryWithBackoff(fn, 3, 100, logger)).rejects.toThrow(
      'Bad request',
    );

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should not retry on 403 forbidden error', async () => {
    const error = new Error('Forbidden');
    (error as any).status = 403;
    const fn = jest.fn().mockRejectedValue(error);

    await expect(retryWithBackoff(fn, 3, 100, logger)).rejects.toThrow(
      'Forbidden',
    );

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on 500 server error', async () => {
    const error = new Error('Server error');
    (error as any).status = 500;
    const fn = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const result = await retryWithBackoff(fn, 3, 100, logger);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should log retry attempts', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Error 1'))
      .mockResolvedValueOnce('success');

    await retryWithBackoff(fn, 3, 100, logger);

    expect(logger.debug).toHaveBeenCalled();
  });
});
