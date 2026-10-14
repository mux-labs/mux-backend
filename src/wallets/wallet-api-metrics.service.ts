import { Injectable, Logger } from '@nestjs/common';
import { WalletNetwork } from './domain/wallet.model';

export type WalletApiOperation =
  | 'create'
  | 'activate'
  | 'key_rotate'
  | 'status_update'
  | 'orchestrate_create'
  | 'update_nickname';

export type WalletApiOutcome =
  | 'success'
  | 'failure'
  | 'created'
  | 'existing'
  | 'idempotent';

export interface WalletApiMetric {
  operation: WalletApiOperation;
  outcome: WalletApiOutcome;
  durationMs: number;
  network?: WalletNetwork;
}

/**
 * A small transport-neutral metrics seam for the Wallet API.
 *
 * It emits stable structured log fields for the current deployment and keeps
 * no user or wallet identifiers as metric labels. A metrics backend can
 * subscribe to this service without changing wallet lifecycle code.
 */
@Injectable()
export class WalletApiMetricsService {
  private readonly logger = new Logger(WalletApiMetricsService.name);

  record(metric: WalletApiMetric): void {
    const fields = [
      'metric=wallet_api_operation',
      `operation=${metric.operation}`,
      `outcome=${metric.outcome}`,
      `durationMs=${Math.max(0, Math.round(metric.durationMs))}`,
    ];
    if (metric.network) fields.push(`network=${metric.network}`);
    this.logger.log(`[wallet-api-metrics] ${fields.join(' ')}`);
  }
}
