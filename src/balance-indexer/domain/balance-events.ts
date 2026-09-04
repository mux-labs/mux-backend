/**
 * Domain event types emitted by the balance indexer.
 *
 * These events are dispatched via WebhookEventEmitterService so consumers
 * (webhook endpoints, internal listeners) can react to balance lifecycle
 * changes without polling.
 */

export interface BalanceSyncedEvent {
  walletId: string;
  balancesUpdated: number;
  mismatchesFound: number;
  durationMs: number;
}

export interface BalanceUpdatedEvent {
  walletId: string;
  /** Human-readable asset label, e.g. "XLM" or "USDC" */
  asset: string;
  previousBalance: string;
  newBalance: string;
  /** Signed difference: newBalance - previousBalance */
  change: string;
}

export interface BalanceMismatchEvent {
  walletId: string;
  asset: string;
  indexedBalance: string;
  onChainBalance: string;
  difference: string;
}
