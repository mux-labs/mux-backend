/**
 * Asset classes supported by the indexer. Mirrors the `AssetType` enum in
 * prisma/schema.prisma; kept as a string union so the domain layer does not
 * depend on the generated Prisma client.
 */
export type BalanceAssetType =
  'NATIVE' | 'CREDIT_ALPHANUM4' | 'CREDIT_ALPHANUM12' | 'LIQUIDITY_POOL_SHARES';

/**
 * Lifecycle of a balance row, mirroring `BalanceSyncStatus` in the Prisma
 * schema. `MISMATCH` is the operator-actionable state: the indexed value and
 * the on-chain value disagree.
 */
export type BalanceSyncStatus =
  'SYNCED' | 'SYNCING' | 'STALE' | 'MISMATCH' | 'FAILED';

/** An indexed balance for one (wallet, asset) pair. */
export interface WalletBalanceRecord {
  walletId: string;
  assetType: BalanceAssetType;
  assetCode: string | null;
  assetIssuer: string | null;
  /** Balance in the asset's smallest unit, as a string to preserve precision. */
  balance: string;
  syncStatus: BalanceSyncStatus;
  lastSyncedAt: Date | null;
  lastSyncedLedger: number | null;
  lastReconciledAt: Date | null;
  reconciliationAttempts: number;
  onChainBalance: string | null;
  mismatchDetectedAt: Date | null;
}

/**
 * An asset selector for reconciliation. `type` is always required; `code` and
 * `issuer` are only meaningful for credit-alphanum assets and MUST be omitted
 * for `NATIVE`.
 */
export interface AssetSelector {
  type: BalanceAssetType;
  code?: string;
  issuer?: string;
}

/** Result of reconciling a single (wallet, asset) pair. */
export interface ReconciliationResult {
  walletId: string;
  asset: AssetSelector;
  indexedBalance: string;
  onChainBalance: string;
  matches: boolean;
}

/** Aggregate result of a multi-wallet sync or reconcile sweep. */
export interface BalanceSweepResult {
  walletsProcessed: number;
  balancesUpdated: number;
  mismatchesFound: number;
}

/** Aggregate result of a single-wallet sync. */
export interface WalletSyncResult {
  walletId: string;
  balancesUpdated: number;
  mismatchesFound: number;
  syncStatus: BalanceSyncStatus;
  lastSyncedAt: Date;
}

/** Report of balances that have not been refreshed within the staleness budget. */
export interface StaleBalanceReport {
  walletId: string;
  staleAssets: Array<{
    assetType: BalanceAssetType;
    assetCode: string | null;
    assetIssuer: string | null;
    lastSyncedAt: Date | null;
  }>;
  /** Oldest `lastSyncedAt` across the stale set, or null when nothing is stale. */
  staleSince: Date | null;
}

/**
 * Authenticated principal driving a balance operation.
 *
 * Roles are deny-by-default: `reconcileAll`/`syncAll` sweeps and any write
 * require at least `operator`. A caller-supplied `subjectId` is never trusted
 * to assert ownership — see `BalanceIndexerService.enforceAuthorization`.
 */
export interface BalanceActor {
  subjectId: string;
  role: 'owner' | 'delegate' | 'guardian' | 'operator' | 'api-key';
  correlationId: string;
}
