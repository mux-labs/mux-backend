import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_DEVELOPER_QUOTA_WINDOW_MS,
  DEFAULT_QUOTA_CLEANUP_BATCH_SIZE,
  RateLimitService,
} from './rate-limit.service';

/**
 * RateLimitCleanupWorker
 *
 * Prunes `RateLimitRecord` rows whose sliding window has closed.
 *
 * Without this job the table grows without bound: every API key × endpoint ×
 * time-window combination adds a row that nothing ever removes, so the index
 * degrades and storage grows indefinitely.
 *
 * Configuration (environment variables):
 *   RATE_LIMIT_CLEANUP_ENABLED          — set to "true" to run in-process
 *                                         (default: "false" / disabled)
 *   RATE_LIMIT_CLEANUP_INTERVAL_MS      — polling interval in ms
 *                                         (default: 3_600_000 / 1 h)
 *   RATE_LIMIT_CLEANUP_BATCH_SIZE       — rows deleted per pass
 *                                         (default: 1000, clamped to 10000)
 *
 * The worker is **opt-in**: a deployment that prefers an external scheduler
 * (a Kubernetes CronJob calling a guarded internal endpoint) leaves this disabled
 * so cleanup runs in exactly one place and cannot be triggered twice.
 *
 * Safety properties:
 *  - **Deny-by-default.** Disabled unless explicitly enabled.
 *  - **Re-entrancy guard.** A tick firing while the previous pass is still
 *    running is skipped, so overlapping ticks cannot double-delete.
 *  - **Fail-closed, non-fatal to the process.** A database outage is logged with
 *    a stable code and reported as a 0-delete no-op; the next tick retries.
 *    Cleanup is a background concern and must never crash the API.
 *  - **No secret leakage.** Logs carry counts and cutoffs only.
 */
@Injectable()
export class RateLimitCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitCleanupWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly rateLimitService: RateLimitService,
    private readonly configService: ConfigService,
  ) {
    this.enabled =
      String(
        this.configService.get<string>('RATE_LIMIT_CLEANUP_ENABLED', 'false'),
      ).toLowerCase() === 'true';
    this.intervalMs = this.configService.get<number>(
      'RATE_LIMIT_CLEANUP_INTERVAL_MS',
      3_600_000,
    );
    this.batchSize = this.configService.get<number>(
      'RATE_LIMIT_CLEANUP_BATCH_SIZE',
      DEFAULT_QUOTA_CLEANUP_BATCH_SIZE,
    );
  }

  /** Whether the in-process worker is enabled for this deployment. */
  isEnabled(): boolean {
    return this.enabled;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Rate limit cleanup worker disabled ' +
          '(set RATE_LIMIT_CLEANUP_ENABLED=true to run it in-process)',
      );
      return;
    }

    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.logger.log(
      `Rate limit cleanup worker started (interval: ${this.intervalMs}ms, ` +
        `batchSize: ${this.batchSize})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) {
      this.logger.log('Rate limit cleanup worker stopped');
    }
  }

  /**
   * Runs one cleanup cycle and returns the number of rows deleted.
   *
   * Returns 0 (without throwing) when the worker is disabled, when a previous
   * pass is still in flight, or when the database is unavailable — so a
   * background outage never surfaces as an unhandled rejection or a false
   * success.
   */
  async run(): Promise<number> {
    if (!this.enabled) {
      return 0;
    }

    if (this.running) {
      this.logger.warn(
        'Rate limit cleanup already running, skipping this tick',
      );
      return 0;
    }

    this.running = true;
    try {
      const deleted = await this.rateLimitService.cleanupOldRecords(
        DEFAULT_DEVELOPER_QUOTA_WINDOW_MS,
        this.batchSize,
      );
      if (deleted > 0) {
        this.logger.log(
          `Rate limit cleanup tick: deleted ${deleted} expired record(s)`,
        );
      }
      return deleted;
    } catch (err) {
      this.logger.error(
        'Rate limit cleanup tick failed',
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
