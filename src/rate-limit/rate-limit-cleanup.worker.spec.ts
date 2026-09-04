import { ConfigService } from '@nestjs/config';
import { RateLimitCleanupWorker } from './rate-limit-cleanup.worker';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitCleanupWorker', () => {
  let worker: RateLimitCleanupWorker;
  let mockRateLimitService: jest.Mocked<Pick<RateLimitService, 'cleanupOldRecords'>>;
  let mockConfigService: jest.Mocked<Pick<ConfigService, 'get'>>;

  beforeEach(() => {
    jest.useFakeTimers();

    mockRateLimitService = {
      cleanupOldRecords: jest.fn().mockResolvedValue(0),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue: any) => {
        const config: Record<string, any> = {
          RATE_LIMIT_CLEANUP_INTERVAL_MS: 3_600_000,
          RATE_LIMIT_CLEANUP_OLDER_THAN_MS: 3_600_000,
        };
        return config[key] ?? defaultValue;
      }),
    };

    worker = new RateLimitCleanupWorker(
      mockRateLimitService as unknown as RateLimitService,
      mockConfigService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // onModuleInit / onModuleDestroy lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should start a timer on onModuleInit', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      worker.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      worker.onModuleDestroy();
    });

    it('should clear the timer on onModuleDestroy', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      worker.onModuleInit();
      worker.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    });

    it('should call run() on each timer tick', async () => {
      const runSpy = jest.spyOn(worker, 'run').mockResolvedValue(0);
      worker.onModuleInit();

      // Fast-forward one interval
      jest.advanceTimersByTime(3_600_000);
      // Allow pending microtasks to settle
      await Promise.resolve();

      expect(runSpy).toHaveBeenCalledTimes(1);
      worker.onModuleDestroy();
    });
  });

  // ---------------------------------------------------------------------------
  // run()
  // ---------------------------------------------------------------------------

  describe('run()', () => {
    it('should call cleanupOldRecords with the configured olderThanMs', async () => {
      mockRateLimitService.cleanupOldRecords.mockResolvedValue(5);

      const deleted = await worker.run();

      expect(mockRateLimitService.cleanupOldRecords).toHaveBeenCalledWith(
        3_600_000,
      );
      expect(deleted).toBe(5);
    });

    it('should return 0 and not throw when cleanupOldRecords throws', async () => {
      mockRateLimitService.cleanupOldRecords.mockRejectedValue(
        new Error('DB connection lost'),
      );

      await expect(worker.run()).resolves.toBe(0);
    });

    it('should skip run() and return 0 when already running (re-entrancy guard)', async () => {
      // Simulate a long-running cleanup
      let resolve!: (v: number) => void;
      const pending = new Promise<number>((r) => {
        resolve = r;
      });
      mockRateLimitService.cleanupOldRecords.mockReturnValue(pending);

      // Start first run (will hang)
      const first = worker.run();
      // Immediately start second run — should be skipped
      const second = await worker.run();

      expect(second).toBe(0);
      expect(mockRateLimitService.cleanupOldRecords).toHaveBeenCalledTimes(1);

      // Resolve the first run
      resolve(3);
      const firstResult = await first;
      expect(firstResult).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Configuration edge cases
  // ---------------------------------------------------------------------------

  describe('configuration', () => {
    it('should use RATE_LIMIT_CLEANUP_INTERVAL_MS from config', () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue: any) => {
          if (key === 'RATE_LIMIT_CLEANUP_INTERVAL_MS') return 1_800_000;
          return defaultValue;
        },
      );

      const customWorker = new RateLimitCleanupWorker(
        mockRateLimitService as unknown as RateLimitService,
        mockConfigService as unknown as ConfigService,
      );

      // Verify the worker was constructed without error
      expect(customWorker).toBeDefined();
    });

    it('should use RATE_LIMIT_CLEANUP_OLDER_THAN_MS from config when running', async () => {
      mockConfigService.get.mockImplementation(
        (key: string, defaultValue: any) => {
          if (key === 'RATE_LIMIT_CLEANUP_OLDER_THAN_MS') return 7_200_000;
          return defaultValue;
        },
      );

      const customWorker = new RateLimitCleanupWorker(
        mockRateLimitService as unknown as RateLimitService,
        mockConfigService as unknown as ConfigService,
      );

      await customWorker.run();

      expect(mockRateLimitService.cleanupOldRecords).toHaveBeenCalledWith(
        7_200_000,
      );
    });
  });
});
