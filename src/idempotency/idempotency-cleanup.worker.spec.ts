import { ConfigService } from '@nestjs/config';
import {
  IdempotencyCleanupWorker,
  MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  resolveBatchSize,
} from './idempotency-cleanup.worker';

describe('resolveBatchSize', () => {
  it('returns a positive integer no larger than the max batch size', () => {
    const size = resolveBatchSize();

    expect(Number.isInteger(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE);
  });

  it('never returns a value the service would reject', () => {
    const size = resolveBatchSize();

    // A non-positive or oversized value would be rejected by the service.
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE);
  });
});

describe('IdempotencyCleanupWorker', () => {
  const buildWorker = (values: Record<string, unknown>) => {
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const service = {
      cleanupExpired: jest.fn().mockResolvedValue(0),
    };

    const worker = new IdempotencyCleanupWorker(config, service as never);

    return { worker, service };
  };

  it('passes a valid batch size to the service on run()', async () => {
    const { worker, service } = buildWorker({});

    await worker.run();

    expect(service.cleanupExpired).toHaveBeenCalledTimes(1);
    const batchSize = service.cleanupExpired.mock.calls[0][0];
    expect(Number.isInteger(batchSize)).toBe(true);
    expect(batchSize).toBeGreaterThan(0);
    expect(batchSize).toBeLessThanOrEqual(
      MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
    );
  });
});
