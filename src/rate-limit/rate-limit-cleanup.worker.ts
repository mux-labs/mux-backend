import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service';

/**
 * RateLimitCleanupWorker
 *
 * Periodically calls RateLimitService.cleanupOldRecords() to prune expired
 * rate-limit windows from the database. Without this, the ApiKeyUsage /
 * RateLimitRecord tables grow unbounded and degrade query performance.
 *
 * Configuration (environment variables):
 *   RATE_LIMIT_CLEANUP_INTERVAL_MS  – polling interval in ms (default: 3_600_000 / 1 h)
 *   RATE_LIMIT_CLEANUP_OLDER_THAN_MS – delete records older than this (default: 3_600_000 / 1 h)
 */
@Injectable()
export class RateLimitCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimitCleanupWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly intervalMs: number;
  private readonly olderThanMs: number;

  constructor(
    private readonly rateLimitService: RateLimitService,
    private readonly configService: ConfigService,
  ) {
    this.intervalMs = this.configService.get<number>(
      'RATE_LIMIT_CLEANUP_INTERVAL_MS',
      3_600_000,
    );
    this.olderThanMs = this.configService.get<number>(
      'RATE_LIMIT_CLEANUP_OLDER_THAN_MS',
      3_600_000,
    );
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.run(), this.intervalMs);
    this.logger.log(
      `Rate-limit cleanup worker started (interval: ${this.intervalMs}ms, ` +
        `olderThan: ${this.olderThanMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log('Rate-limit cleanup worker stopped');
  }

  /**
   * Runs one cleanup cycle. Re-entrant guard prevents concurrent runs if an
   * interval fires while the previous cycle is still in progress.
   */
  async run(): Promise<number> {
    if (this.running) {
      this.logger.warn(
        'Rate-limit cleanup already running, skipping this tick',
      );
      return 0;
    }

    this.running = true;
    try {
      const deleted = await this.rateLimitService.cleanupOldRecords(
        this.olderThanMs,
      );
      if (deleted > 0) {
        this.logger.log(
          `Rate-limit cleanup tick: deleted ${deleted} stale record(s)`,
        );
      }
      return deleted;
    } catch (err) {
      this.logger.error(
        'Rate-limit cleanup tick failed',
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
