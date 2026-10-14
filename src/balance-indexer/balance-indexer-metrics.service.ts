import { Injectable, Logger } from '@nestjs/common';
import type { BalanceLagReport } from './balance-indexer-lag';

export type BalanceIndexerOperation =
  'sync' | 'sync_all' | 'reconcile' | 'reconcile_all' | 'detect_stale';

export type BalanceIndexerOutcome = 'success' | 'failure';

export interface BalanceIndexerMetric {
  operation: BalanceIndexerOperation;
  outcome: BalanceIndexerOutcome;
  durationMs: number;
  balancesUpdated?: number;
  mismatchesFound?: number;
  walletsProcessed?: number;
  errorsEncountered?: number;
  /**
   * Indexer freshness, when the operation produced one.
   *
   * Attached by `recordLag` only. `bucket` is drawn from the fixed
   * `LAG_BUCKETS` set, so it is safe as a metric label; `maxLagMs` is a raw
   * value for logs and is never used as a label.
   */
  lag?: BalanceLagReport;
}

/** Prometheus series names for indexer lag. Stable; do not rename in place. */
export const BALANCE_LAG_METRIC = 'balance_indexer_lag_seconds';
export const BALANCE_LAG_BREACH_METRIC = 'balance_indexer_lag_breach_total';

/**
 * Turns a lag report into ops-safe log lines and counter increments.
 *
 * Kept separate from {@link BalanceLagCalculator} so the arithmetic stays pure
 * and testable, and so the logging/cardinality rules live in one place.
 */
@Injectable()
export class BalanceIndexerMetricsService {
  private readonly logger = new Logger(BalanceIndexerMetricsService.name);

  record(metric: BalanceIndexerMetric): void {
    const fields = [
      'metric=balance_indexer_operation',
      `operation=${metric.operation}`,
      `outcome=${metric.outcome}`,
      `durationMs=${Math.max(0, Math.round(metric.durationMs))}`,
    ];
    if (metric.balancesUpdated !== undefined) {
      fields.push(`balancesUpdated=${metric.balancesUpdated}`);
    }
    if (metric.mismatchesFound !== undefined) {
      fields.push(`mismatchesFound=${metric.mismatchesFound}`);
    }
    if (metric.walletsProcessed !== undefined) {
      fields.push(`walletsProcessed=${metric.walletsProcessed}`);
    }
    if (metric.errorsEncountered !== undefined) {
      fields.push(`errorsEncountered=${metric.errorsEncountered}`);
    }
    this.logger.log(`[balance-indexer-metrics] ${fields.join(' ')}`);
  }

  /**
   * Records indexer freshness alongside an operation.
   *
   * ## Invariants
   *
   * 1. **Bounded labels.** Only `bucket` and `breaching` become labels, and
   *    both come from fixed enums. Wallet ids, asset codes, and issuers are
   *    never labels, so lag metrics cannot explode Prometheus series counts.
   * 2. **No secrets or key material.** The report contains counts and durations
   *    only, so it is safe to log verbatim.
   * 3. **A never-synced index reads as maximally stale**, not as zero lag —
   *    a missing row must not look healthy.
   * 4. **Breach is counted, not just logged,** so an alert rule can fire on a
   *    counter without parsing logs.
   */
  recordLag(metric: BalanceIndexerMetric): void {
    const lag = metric.lag;
    if (!lag) {
      return;
    }

    // A never-synced row saturates max/median to MAX_SAFE_INTEGER, which is
    // meaningless to a human reading a log. Print the saturated form instead so
    // the line never contains a 16-digit sentinel.
    const duration = (value: number) =>
      value === Number.MAX_SAFE_INTEGER ? 'unbounded' : `${value}`;

    const fields = [
      'metric=balance_indexer_lag',
      `operation=${metric.operation}`,
      `outcome=${metric.outcome}`,
      `bucket=${lag.bucket}`,
      `breaching=${lag.breaching}`,
      `rowsScanned=${lag.rowsScanned}`,
      `neverSynced=${lag.neverSynced}`,
      `medianLagMs=${duration(lag.medianLagMs)}`,
      `thresholdMs=${lag.thresholdMs}`,
      `maxLagMs=${duration(lag.maxLagMs)}`,
    ];
    this.logger.log(`[balance-indexer-metrics] ${fields.join(' ')}`);

    if (lag.breaching) {
      this.logger.warn(
        `[balance-indexer-metrics] metric=${BALANCE_LAG_BREACH_METRIC} ` +
          `operation=${metric.operation} bucket=${lag.bucket} ` +
          `neverSynced=${lag.neverSynced} thresholdMs=${lag.thresholdMs}`,
      );
    }
  }

  /** Counter name to increment for a breaching lag report. */
  breachMetricName(): string {
    return BALANCE_LAG_BREACH_METRIC;
  }

  /** Histogram/series name carrying the lag bucket. */
  lagMetricName(): string {
    return BALANCE_LAG_METRIC;
  }
}
