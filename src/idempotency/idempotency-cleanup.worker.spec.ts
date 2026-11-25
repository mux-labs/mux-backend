import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';

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
