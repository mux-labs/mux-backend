import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IdempotencyService,
  DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
} from './idempotency.service';

/** Default polling interval (1 h). */
const DEFAULT_IDEMPOTENCY_CLEANUP_INTERVAL_MS = 3_600_000;

/**
 * Largest delay `setInterval` accepts (2^31 - 1 ms, about 24.8 days). Larger
 * values overflow and Node fires the callback immediately, which would turn
 * the prune into a hot loop.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * IdempotencyCleanupWorker
 *
 * Periodically prunes expired `IdempotencyRecord` rows.
 *
 * Without this job the table grows without bound: every money-path write that
 * carries an idempotency key inserts a row that is never removed, so the
 * `@@index([expiresAt])` degrades and the table consumes storage indefinitely.
 *
 * Configuration (environment variables, validated at boot by
 * `src/config/env.validation.ts` and exposed through
 * `src/config/configuration.ts`):
 *   IDEMPOTENCY_CLEANUP_ENABLED          – set to "true" to run in-process
 *                                          (default: "false" / disabled)
 *   IDEMPOTENCY_CLEANUP_INTERVAL_MS      – polling interval in ms
 *                                          (default: 3_600_000 / 1 h)
 *   IDEMPOTENCY_CLEANUP_BATCH_SIZE       – rows deleted per pass
 *                                          (default: 1000, clamped to 10000)
 *
 * The worker is **opt-in**: a deployment that prefers an external scheduler
 * (Kubernetes CronJob calling a guarded internal endpoint) leaves this
 * disabled so cleanup runs in exactly one place and cannot be triggered twice.
 *
 * Safety properties:
 *  - **Deny-by-default.** Disabled unless explicitly enabled.
 *  - **Re-entrancy guard.** A tick that fires while the previous pass is still
 *    running is skipped, so overlapping ticks cannot double-delete or pile up
 *    transactions.
 *  - **Fail-closed, non-fatal to the process.** A database outage is logged
 *    with a stable code and reported as a 0-delete no-op; the next tick
 *    retries. Cleanup is a background concern and must never crash the API.
 *  - **No secret leakage.** Logs carry counts and cutoffs only.
 */
@Injectable()
export class IdempotencyCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyCleanupWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly idempotencyService: IdempotencyService,
    private readonly configService: ConfigService,
  ) {
    const cleanup = this.configService.get<{
      enabled: boolean;
      intervalMs: number;
      batchSize: number;
    }>('idempotencyCleanup');

    this.enabled = cleanup?.enabled ?? false;
    this.intervalMs = this.resolveIntervalMs(cleanup?.intervalMs);
    this.batchSize = this.resolveBatchSize(cleanup?.batchSize);
  }

  /** Whether the in-process worker is enabled for this deployment. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Returns a timer delay that is finite, positive and within `setInterval`'s
   * range; anything else falls back to the default.
   */
  private resolveIntervalMs(raw: unknown): number {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value <= MAX_TIMER_DELAY_MS) {
      return value;
    }
    this.logger.warn(
      `Invalid IDEMPOTENCY_CLEANUP_INTERVAL_MS=${String(raw)}; ` +
        `falling back to ${DEFAULT_IDEMPOTENCY_CLEANUP_INTERVAL_MS}ms`,
    );
    return DEFAULT_IDEMPOTENCY_CLEANUP_INTERVAL_MS;
  }

  /**
   * Returns a positive integer batch size no larger than
   * `MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE`, so `run()` never hands the service a
   * value it would reject.
   */
  private resolveBatchSize(raw: unknown): number {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      this.logger.warn(
        `Invalid IDEMPOTENCY_CLEANUP_BATCH_SIZE=${String(raw)}; ` +
          `falling back to ${DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE}`,
      );
      return DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE;
    }
    if (value > MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE) {
      this.logger.warn(
        `IDEMPOTENCY_CLEANUP_BATCH_SIZE=${value} exceeds ` +
          `${MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE}; clamping to the maximum`,
      );
      return MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE;
    }
    return value;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log(
        'Idempotency cleanup worker disabled ' +
          '(set IDEMPOTENCY_CLEANUP_ENABLED=true to run it in-process)',
      );
      return;
    }

    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.logger.log(
      `Idempotency cleanup worker started (interval: ${this.intervalMs}ms, ` +
        `batchSize: ${this.batchSize})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) {
      this.logger.log('Idempotency cleanup worker stopped');
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
        'Idempotency cleanup already running, skipping this tick',
      );
      return 0;
    }

    this.running = true;
    try {
      const result = await this.idempotencyService.cleanupExpiredRecords(
        this.batchSize,
      );
      if (result.deleted > 0) {
        this.logger.log(
          `Idempotency cleanup tick: deleted ${result.deleted} expired record(s)` +
            (result.hasMore ? ' (more remain, next tick continues)' : ''),
        );
      }
      return result.deleted;
    } catch (err) {
      this.logger.error(
        'Idempotency cleanup tick failed',
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
