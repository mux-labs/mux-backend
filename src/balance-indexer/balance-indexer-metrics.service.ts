import { Injectable, Logger } from '@nestjs/common';

export type BalanceIndexerOperation =
  | 'sync'
  | 'sync_all'
  | 'reconcile'
  | 'reconcile_all'
  | 'detect_stale';

export type BalanceIndexerOutcome = 'success' | 'failure';

export interface BalanceIndexerMetric {
  operation: BalanceIndexerOperation;
  outcome: BalanceIndexerOutcome;
  durationMs: number;
  balancesUpdated?: number;
  mismatchesFound?: number;
  walletsProcessed?: number;
  errorsEncountered?: number;
}

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
}
