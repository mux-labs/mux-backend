import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  IdempotencyService,
  IDEMPOTENCY_RECORD_STORE,
  IdempotencyRecordStore,
  IdempotencyCleanupErrorCode,
  DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
} from './idempotency.service';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeStore = (deleteMany: jest.Mock): IdempotencyRecordStore => ({
  idempotencyRecord: {
    deleteMany: deleteMany,
  },
});

async function buildService(
  deleteMany: jest.Mock = jest.fn().mockResolvedValue({ count: 0 }),
): Promise<{ service: IdempotencyService; metrics: MetricsService }> {
  const incrementCounter = jest.fn();
  const metrics = { incrementCounter } as unknown as MetricsService;
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      IdempotencyService,
      { provide: IDEMPOTENCY_RECORD_STORE, useValue: makeStore(deleteMany) },
      { provide: MetricsService, useValue: metrics },
    ],
  }).compile();

  return { service: module.get(IdempotencyService), metrics, incrementCounter };
}

describe('IdempotencyService.cleanupExpiredRecords', () => {
  describe('TTL semantics', () => {
    it('deletes only records whose expiresAt is strictly before the cutoff', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
      const { service } = await buildService(deleteMany);

      await service.cleanupExpiredRecords(500, NOW);

      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: new Date('2026-01-01T00:00:00.000Z') } },
      });
    });

    it('never deletes a record that has not yet expired', async () => {
      // Regression guard for the invariant that protects against re-opening the
      // duplicate-write window: the query is a strict `lt`, so a live record
      // whose TTL has not elapsed is untouched.
      const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
      const { service } = await buildService(deleteMany);

      await service.cleanupExpiredRecords(100, NOW);

      const call = (
        deleteMany.mock.calls as Array<
          [{ where: Record<string, Record<string, unknown>> }]
        >
      )[0][0];
      expect(call.where.expiresAt.lt).toBeInstanceOf(Date);
      expect(call.where.expiresAt.lte).toBeUndefined();
      expect(call.where.expiresAt.gte).toBeUndefined();
    });

    it('returns the deleted count and cutoff', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 7 });
      const { service } = await buildService(deleteMany);

      const result = await service.cleanupExpiredRecords(100, NOW);

      expect(result).toEqual({
        deleted: 7,
        hasMore: false,
        cutoff: NOW.toISOString(),
      });
    });

    it('defaults the clock to now when no date is supplied', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
      const { service } = await buildService(deleteMany);

      const before = Date.now();
      const result = await service.cleanupExpiredRecords(10);
      const after = Date.now();

      const cutoff = new Date(result.cutoff).getTime();
      expect(cutoff).toBeGreaterThanOrEqual(before);
      expect(cutoff).toBeLessThanOrEqual(after);
    });
  });

  describe('bounded batches (griefing resistance)', () => {
    it('uses the default batch size when none is supplied', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
      const { service } = await buildService(deleteMany);

      const result = await service.cleanupExpiredRecords(undefined, NOW);

      // A full default batch implies more work remains for the next tick.
      expect(result.hasMore).toBe(false);
      expect(deleteMany).toHaveBeenCalledTimes(1);
    });

    it('clamps an oversized batch request to the maximum', async () => {
      const deleteMany = jest.fn().mockResolvedValue({
        count: MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
      });
      const { service } = await buildService(deleteMany);

      const result = await service.cleanupExpiredRecords(1_000_000, NOW);

      // A full clamped batch signals "more remain" so the worker keeps ticking.
      expect(result.hasMore).toBe(true);
    });

    it('reports hasMore only when a full batch was deleted', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 9 });
      const { service } = await buildService(deleteMany);

      const result = await service.cleanupExpiredRecords(10, NOW);

      expect(result.hasMore).toBe(false);
      expect(result.deleted).toBe(9);
    });

    it('defaults to DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE', () => {
      expect(DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE).toBe(1000);
      expect(MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE).toBe(10_000);
    });
  });

  describe('input validation', () => {
    it.each([0, -1, -1000, 1.5, Number.NaN])(
      'rejects a non-positive-integer batch size (%p)',
      async (batchSize) => {
        const deleteMany = jest.fn();
        const { service } = await buildService(deleteMany);

        await expect(
          service.cleanupExpiredRecords(batchSize, NOW),
        ).rejects.toMatchObject({
          code: IdempotencyCleanupErrorCode.INVALID_BATCH_SIZE,
        });
        // Fail closed: no query is attempted with an invalid bound.
        expect(deleteMany).not.toHaveBeenCalled();
      },
    );
  });

  describe('fail-closed on dependency outage', () => {
    it('rejects with a stable code when the database is unavailable', async () => {
      const deleteMany = jest
        .fn()
        .mockRejectedValue(new Error('connection refused'));
      const { service } = await buildService(deleteMany);

      await expect(
        service.cleanupExpiredRecords(100, NOW),
      ).rejects.toMatchObject({
        code: IdempotencyCleanupErrorCode.DEPENDENCY_UNAVAILABLE,
      });
    });

    it('does NOT report a false success (0 deleted) on outage', async () => {
      const deleteMany = jest.fn().mockRejectedValue(new Error('timeout'));
      const { service } = await buildService(deleteMany);

      // A swallowed outage would look identical to "nothing to clean up" and
      // would silently let the table grow forever.
      await expect(
        service.cleanupExpiredRecords(100, NOW),
      ).rejects.toBeDefined();
    });

    it('emits a dependency-unavailable metric on outage', async () => {
      const deleteMany = jest.fn().mockRejectedValue(new Error('timeout'));
      const { service, incrementCounter } = await buildService(deleteMany);

      await expect(
        service.cleanupExpiredRecords(100, NOW),
      ).rejects.toBeDefined();

      expect(incrementCounter).toHaveBeenCalledWith(
        'idempotency.cleanup.dependency_unavailable',
        1,
      );
    });
  });

  describe('replay safety', () => {
    it('is safe to run repeatedly — each pass deletes a disjoint set', async () => {
      const deleteMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 2 })
        .mockResolvedValueOnce({ count: 0 });
      const { service } = await buildService(deleteMany);

      const first = await service.cleanupExpiredRecords(100, NOW);
      const second = await service.cleanupExpiredRecords(100, NOW);

      expect(first.deleted).toBe(2);
      expect(second.deleted).toBe(0);
      expect(deleteMany).toHaveBeenCalledTimes(2);
    });

    it('concurrent passes do not throw', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
      const { service } = await buildService(deleteMany);

      const results = await Promise.all([
        service.cleanupExpiredRecords(100, NOW),
        service.cleanupExpiredRecords(100, NOW),
        service.cleanupExpiredRecords(100, NOW),
      ]);

      expect(results).toHaveLength(3);
    });
  });

  describe('no secret leakage', () => {
    it('returns only counts and a cutoff, never keys or payloads', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 4 });
      const { service } = await buildService(deleteMany);

      const result = await service.cleanupExpiredRecords(100, NOW);

      expect(Object.keys(result).sort()).toEqual([
        'cutoff',
        'deleted',
        'hasMore',
      ]);
    });
  });
});

describe('IdempotencyCleanupWorker', () => {
  const makeWorker = async (
    env: Record<string, string | number>,
  ): Promise<{
    worker: IdempotencyCleanupWorker;
    cleanupExpiredRecords: jest.Mock;
  }> => {
    const cleanupExpiredRecords = jest.fn(() =>
      Promise.resolve({
        deleted: 0,
        hasMore: false,
        cutoff: NOW.toISOString(),
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyCleanupWorker,
        {
          provide: IdempotencyService,
          useValue: { cleanupExpiredRecords },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) => env[key] ?? fallback,
          },
        },
      ],
    }).compile();

    return {
      worker: module.get(IdempotencyCleanupWorker),
      cleanupExpiredRecords,
    };
  };

  describe('deny-by-default', () => {
    it('is disabled when IDEMPOTENCY_CLEANUP_ENABLED is unset', async () => {
      const { worker } = await makeWorker({});
      expect(worker.isEnabled()).toBe(false);
    });

    it('is disabled for any value other than "true"', async () => {
      for (const value of ['false', 'TRUE_ISH', '1', 'yes', '']) {
        const { worker } = await makeWorker({
          IDEMPOTENCY_CLEANUP_ENABLED: value,
        });
        expect(worker.isEnabled()).toBe(false);
      }
    });

    it('run() is a no-op when disabled', async () => {
      const { worker, cleanupExpiredRecords } = await makeWorker({});
      await expect(worker.run()).resolves.toBe(0);
      expect(cleanupExpiredRecords).not.toHaveBeenCalled();
    });
  });

  describe('when enabled', () => {
    const ENABLED = { IDEMPOTENCY_CLEANUP_ENABLED: 'true' };

    it('deletes expired records and returns the count', async () => {
      const { worker, cleanupExpiredRecords } = await makeWorker(ENABLED);
      cleanupExpiredRecords.mockResolvedValue({
        deleted: 5,
        hasMore: false,
        cutoff: NOW.toISOString(),
      });

      await expect(worker.run()).resolves.toBe(5);
    });

    it('passes the configured batch size through', async () => {
      const { worker, cleanupExpiredRecords } = await makeWorker({
        ...ENABLED,
        IDEMPOTENCY_CLEANUP_BATCH_SIZE: 250,
      });

      await worker.run();

      expect(cleanupExpiredRecords).toHaveBeenCalledWith(250);
    });

    it('fails closed to 0 when the database is unavailable', async () => {
      const { worker, cleanupExpiredRecords } = await makeWorker(ENABLED);
      cleanupExpiredRecords.mockRejectedValue(new Error('connection refused'));

      // Must not surface as an unhandled rejection on a background timer.
      await expect(worker.run()).resolves.toBe(0);
    });

    it('skips an overlapping tick instead of running concurrently', async () => {
      const { worker, cleanupExpiredRecords } = await makeWorker(ENABLED);
      let release: () => void = () => undefined;
      cleanupExpiredRecords.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                deleted: 1,
                hasMore: false,
                cutoff: NOW.toISOString(),
              });
          }),
      );

      const first = worker.run();
      const second = await worker.run();
      expect(second).toBe(0);

      release();
      await expect(first).resolves.toBe(1);
      expect(cleanupExpiredRecords).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle', () => {
    it('does not start a timer when disabled', async () => {
      const { worker } = await makeWorker({});
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      worker.onModuleInit();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
    });

    it('starts and stops the timer when enabled', async () => {
      const { worker } = await makeWorker({
        IDEMPOTENCY_CLEANUP_ENABLED: 'true',
      });
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      worker.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      worker.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
  });
});
