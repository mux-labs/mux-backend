import { Injectable, Logger } from '@nestjs/common';

export interface TransactionMetricsSnapshot {
  transactionsCreatedTotal: number;
  transactionsCreatedByAsset: Record<string, number>;
  transactionsStatusUpdatedTotal: number;
  transactionsStatusUpdatedByTransition: Record<string, number>;
  transactionsFailedTotal: number;
  idempotencyHitsTotal: number;
  cacheHitsTotal: number;
  cacheMissesTotal: number;
  feeBumpCapRejectionsTotal: number;
}

@Injectable()
export class TransactionMetricsService {
  private readonly logger = new Logger(TransactionMetricsService.name);

  private transactionsCreatedTotal = 0;
  private readonly transactionsCreatedByAsset: Record<string, number> = {};
  private transactionsStatusUpdatedTotal = 0;
  private readonly transactionsStatusUpdatedByTransition: Record<
    string,
    number
  > = {};
  private transactionsFailedTotal = 0;
  private idempotencyHitsTotal = 0;
  private cacheHitsTotal = 0;
  private cacheMissesTotal = 0;
  private feeBumpCapRejectionsTotal = 0;

  incrementTransactionCreated(assetType: string): void {
    this.transactionsCreatedTotal++;
    this.transactionsCreatedByAsset[assetType] =
      (this.transactionsCreatedByAsset[assetType] ?? 0) + 1;
    this.logger.debug(
      `transaction_created asset=${assetType} total=${this.transactionsCreatedTotal}`,
    );
  }

  incrementStatusUpdated(fromStatus: string, toStatus: string): void {
    this.transactionsStatusUpdatedTotal++;
    const key = `${fromStatus}_to_${toStatus}`;
    this.transactionsStatusUpdatedByTransition[key] =
      (this.transactionsStatusUpdatedByTransition[key] ?? 0) + 1;
    if (toStatus === 'FAILED') {
      this.transactionsFailedTotal++;
    }
    this.logger.debug(
      `transaction_status_updated ${key} total=${this.transactionsStatusUpdatedTotal}`,
    );
  }

  incrementIdempotencyHit(): void {
    this.idempotencyHitsTotal++;
    this.logger.debug(
      `transaction_idempotency_hit total=${this.idempotencyHitsTotal}`,
    );
  }

  incrementCacheHit(): void {
    this.cacheHitsTotal++;
    this.logger.debug(`transaction_cache_hit total=${this.cacheHitsTotal}`);
  }

  incrementCacheMiss(): void {
    this.cacheMissesTotal++;
    this.logger.debug(`transaction_cache_miss total=${this.cacheMissesTotal}`);
  }

  /**
   * Records a fee-bump submission that was refused because the computed fee
   * exceeded the configured `FEE_BUMP_MAX_FEE` cap (issue #800). This guards
   * against unbounded sponsorship of relayer fees.
   */
  incrementFeeBumpCapRejection(): void {
    this.feeBumpCapRejectionsTotal++;
    this.logger.warn(
      `fee_bump_cap_rejection total=${this.feeBumpCapRejectionsTotal}`,
    );
  }

  getSnapshot(): TransactionMetricsSnapshot {
    return {
      transactionsCreatedTotal: this.transactionsCreatedTotal,
      transactionsCreatedByAsset: { ...this.transactionsCreatedByAsset },
      transactionsStatusUpdatedTotal: this.transactionsStatusUpdatedTotal,
      transactionsStatusUpdatedByTransition: {
        ...this.transactionsStatusUpdatedByTransition,
      },
      transactionsFailedTotal: this.transactionsFailedTotal,
      idempotencyHitsTotal: this.idempotencyHitsTotal,
      cacheHitsTotal: this.cacheHitsTotal,
      cacheMissesTotal: this.cacheMissesTotal,
      feeBumpCapRejectionsTotal: this.feeBumpCapRejectionsTotal,
    };
  }
}
