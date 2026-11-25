import { Counter } from 'prom-client';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';

describe('IdempotencyCleanupWorker error counter', () => {
  const getErrorCounter = (): Counter<string> => {
    const worker = Object.create(
      IdempotencyCleanupWorker.prototype,
    ) as IdempotencyCleanupWorker;
    return (worker as unknown as { error: Counter<string> }).error;
  };

  it('is a prom-client Counter named for cleanup errors', () => {
    const error = getErrorCounter();

    expect(error).toBeInstanceOf(Counter);
    expect(error.name).toBe('idempotency_cleanup_errors_total');
  });

  it('increments by one on each failure and keeps the series visible at zero', async () => {
    const error = getErrorCounter();

    const before = await error.get();
    const beforeValue = before.values[0]?.value ?? 0;

    error.inc();

    const after = await error.get();
    expect(after.values[0]?.value).toBe(beforeValue + 1);
  });
});
