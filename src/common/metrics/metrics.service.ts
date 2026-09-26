import { Injectable, Logger } from '@nestjs/common';

/**
 * Ops-safe metrics service.
 *
 * Emits counters and histograms for observability without leaking
 * secrets, raw key material, or PII. All metric labels are
 * constrained to a safe character set.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  /**
   * Increment a named counter by the given amount.
   * Labels are sanitized to be log-safe.
   */
  incrementCounter(name: string, value: number = 1): void {
    const safeName = this.sanitizeLabel(name);
    this.logger.debug(`counter_inc ${safeName}=${value}`);
  }

  /**
   * Record a histogram observation.
   */
  recordHistogram(name: string, value: number): void {
    const safeName = this.sanitizeLabel(name);
    this.logger.debug(`histogram ${safeName}=${value}`);
  }

  private sanitizeLabel(label: string): string {
    return label.replace(/[^A-Za-z0-9_:.-]/g, '_');
  }
}
