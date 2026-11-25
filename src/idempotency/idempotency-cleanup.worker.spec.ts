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

describe('IdempotencyCleanupWorker interval', () => {
  const getErrorCounter = (): Counter<string> => {
    const worker = Object.create(
      IdempotencyCleanupWorker.prototype,
    ) as IdempotencyCleanupWorker;
    return (worker as unknown as { error: Counter<string> }).error;
  };

  const getInterval = (): ((...args: unknown[]) => unknown) => {
    const worker = Object.create(
      IdempotencyCleanupWorker.prototype,
    ) as IdempotencyCleanupWorker;
    return (worker as unknown as { interval: (...args: unknown[]) => unknown })
      .interval;
  };

  it('counts a cleanup tick that fails with an error', async () => {
    const error = getErrorCounter();
    const interval = getInterval();

    const before = await error.get();
    const beforeValue = before.values[0]?.value ?? 0;

    const failure = new Error('database outage');
    const cleanup = jest.fn().mockRejectedValue(failure);

    await expect(
      Promise.resolve(interval.call({ cleanup })),
    ).rejects.toBe(failure);

    const after = await error.get();
    expect(after.values[0]?.value).toBe(beforeValue + 1);
  });

  it('does not count a cleanup tick that succeeds', async () => {
    const error = getErrorCounter();
    const interval = getInterval();

    const before = await error.get();
    const beforeValue = before.values[0]?.value ?? 0;

    const cleanup = jest.fn().mockResolvedValue(undefined);

    await Promise.resolve(interval.call({ cleanup }));

    const after = await error.get();
    expect(after.values[0]?.value).toBe(beforeValue);
  });
});

describe('IdempotencyCleanupWorker isEnabled', () => {
  const getIsEnabled = (): (() => boolean) => {
    const worker = Object.create(
      IdempotencyCleanupWorker.prototype,
    ) as IdempotencyCleanupWorker;
    return (worker as unknown as { isEnabled: () => boolean }).isEnabled;
  };

  it('reports the in-process worker as enabled for this deployment', () => {
    const isEnabled = getIsEnabled();

    expect(isEnabled.call({})).toBe(true);
  });
});

describe('IdempotencyCleanupWorker', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function buildWorker(overrides: {
    enabled?: boolean;
    deleteMany?: jest.Mock;
  } = {}) {
    const deleteMany =
      overrides.deleteMany ?? jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      idempotencyKey: { deleteMany },
    } as unknown as ConstructorParameters<
      typeof IdempotencyCleanupWorker
    >[0];

    const worker = new IdempotencyCleanupWorker(prisma);

    if (overrides.enabled === false) {
      jest.spyOn(worker as any, 'isEnabled').mockReturnValue(false);
    }

    return { worker, deleteMany };
  }

  describe('run', () => {
    it('returns the number of rows deleted on a normal cleanup cycle', async () => {
      const { worker, deleteMany } = buildWorker({
        deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      });

      await expect(worker.run()).resolves.toBe(7);
      expect(deleteMany).toHaveBeenCalledTimes(1);
    });

    it('returns 0 without throwing when the worker is disabled', async () => {
      const { worker, deleteMany } = buildWorker({ enabled: false });

      await expect(worker.run()).resolves.toBe(0);
      expect(deleteMany).not.toHaveBeenCalled();
    });

    it('returns 0 without throwing when a previous pass is still in flight', async () => {
      let resolveDelete: (value: { count: number }) => void = () => undefined;
      const deleteMany = jest.fn().mockImplementation(
        () =>
          new Promise<{ count: number }>((resolve) => {
            resolveDelete = resolve;
          }),
      );
      const { worker } = buildWorker({ deleteMany });

      const firstPass = worker.run();
      await expect(worker.run()).resolves.toBe(0);

      resolveDelete({ count: 3 });
      await expect(firstPass).resolves.toBe(3);
      expect(deleteMany).toHaveBeenCalledTimes(1);
    });

    it('returns 0 without throwing when the database is unavailable', async () => {
      const { worker } = buildWorker({
        deleteMany: jest.fn().mockRejectedValue(new Error('db down')),
      });

      await expect(worker.run()).resolves.toBe(0);
    });
  });
});
