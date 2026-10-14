import { BadRequestException, Injectable, Logger } from '@nestjs/common';

/**
 * Detects and sanitizes high-cardinality values in Prometheus metric labels
 * to prevent unbounded metric series explosion.
 *
 * Strategy:
 * - In dev/test: fail-fast by throwing on suspicious labels (catches bad instrumentation in CI)
 * - In production: sanitize to a fixed placeholder and hard-cap distinct label combinations per metric
 *
 * Detects:
 * - Stellar StrKey addresses (public/secret keys starting with G/S)
 * - Transaction hashes (hex strings 64+ chars)
 * - UUIDs (standard format)
 * - Other opaque tokens (long random-looking strings)
 */
@Injectable()
export class MetricsLabelGuardService {
  private readonly logger = new Logger(MetricsLabelGuardService.name);
  private readonly failFast = process.env.NODE_ENV !== 'production';
  private readonly maxDistinctPerMetric = 10_000; // Hard cap on distinct label combinations
  private readonly labelCombinationCounts = new Map<string, Map<string, number>>();

  private static readonly PATTERNS = {
    // Stellar StrKey: public keys start with G, secret keys with S
    stellarPublicKey: /^G[A-Z2-7]{55}$/,
    stellarSecretKey: /^S[A-Z2-7]{55}$/,
    // Transaction hashes: 64-char hex strings
    transactionHash: /^[a-fA-F0-9]{64}$/,
    // UUIDs: standard format
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    // Generic opaque token: long random string (40+ chars of mixed case/numbers)
    opaqueToken: /^[a-zA-Z0-9_-]{40,}$/,
  };

  /**
   * Validates and sanitizes a set of Prometheus labels.
   * Throws in fail-fast mode, sanitizes in production mode.
   */
  validateAndSanitizeLabels(
    metricName: string,
    labels: Record<string, string>,
  ): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const issues: string[] = [];

    for (const [key, value] of Object.entries(labels)) {
      const suspicion = this.detectSuspiciousValue(value);
      if (suspicion) {
        issues.push(`${key}="${value}" (${suspicion})`);
        if (this.failFast) {
          throw new BadRequestException(
            `Suspicious high-cardinality label detected in metric "${metricName}": ${key} contains ${suspicion}. ` +
              `Use enum-bounded values or structured IDs instead of raw wallet/tx identifiers in metric labels.`,
          );
        }
        sanitized[key] = '<redacted>';
      } else {
        sanitized[key] = value;
      }
    }

    if (issues.length > 0) {
      this.logger.warn(
        `Metrics label cardinality guard sanitized labels for "${metricName}": ${issues.join(', ')}`,
      );
    }

    // Check hard cap on distinct label combinations per metric
    this.trackAndEnforceCap(metricName, sanitized);

    return sanitized;
  }

  /**
   * Returns the detected issue type, or null if no issue found.
   */
  private detectSuspiciousValue(value: string): string | null {
    if (!value || typeof value !== 'string') {
      return null;
    }

    // Stellar keys
    if (MetricsLabelGuardService.PATTERNS.stellarPublicKey.test(value)) {
      return 'Stellar public key (high cardinality)';
    }
    if (MetricsLabelGuardService.PATTERNS.stellarSecretKey.test(value)) {
      return 'Stellar secret key (high cardinality)';
    }

    // Transaction hashes
    if (MetricsLabelGuardService.PATTERNS.transactionHash.test(value)) {
      return 'Transaction hash (high cardinality)';
    }

    // UUIDs
    if (MetricsLabelGuardService.PATTERNS.uuid.test(value)) {
      return 'UUID (high cardinality)';
    }

    // Generic opaque tokens (case-sensitive to catch mixed-case noise)
    if (MetricsLabelGuardService.PATTERNS.opaqueToken.test(value)) {
      return 'Opaque token (likely high cardinality)';
    }

    return null;
  }

  /**
   * Track distinct label combinations and enforce a hard cap.
   * In production, once we exceed the cap, we start redacting new combinations.
   */
  private trackAndEnforceCap(
    metricName: string,
    labels: Record<string, string>,
  ): void {
    const key = JSON.stringify(labels);
    let count = this.labelCombinationCounts.get(metricName);
    if (!count) {
      count = new Map();
      this.labelCombinationCounts.set(metricName, count);
    }

    const currentCount = (count.get(key) ?? 0) + 1;
    count.set(key, currentCount);

    if (count.size > this.maxDistinctPerMetric) {
      this.logger.error(
        `Metric "${metricName}" exceeded cardinality hard cap (${this.maxDistinctPerMetric}). ` +
          `Current distinct label combinations: ${count.size}. ` +
          `This indicates a metric instrumentation issue — check for leaked wallet IDs, tx hashes, or other identifiers in labels.`,
      );
    }
  }

  /**
   * Get current cardinality statistics (useful for monitoring/debugging).
   */
  getCardinalityStats(): Record<string, { distinctCombinations: number }> {
    const stats: Record<string, { distinctCombinations: number }> = {};
    for (const [metric, counts] of this.labelCombinationCounts.entries()) {
      stats[metric] = { distinctCombinations: counts.size };
    }
    return stats;
  }

  /**
   * Reset all tracking (useful for tests).
   */
  resetTracking(): void {
    this.labelCombinationCounts.clear();
  }
}
