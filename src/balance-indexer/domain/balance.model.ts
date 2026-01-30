/**
 * Domain models for balance indexing
 */

export enum AssetType {
  NATIVE = 'NATIVE',
  CREDIT_ALPHANUM4 = 'CREDIT_ALPHANUM4',
  CREDIT_ALPHANUM12 = 'CREDIT_ALPHANUM12',
  LIQUIDITY_POOL_SHARES = 'LIQUIDITY_POOL_SHARES',
}

export enum BalanceSyncStatus {
  SYNCED = 'SYNCED',
  SYNCING = 'SYNCING',
  STALE = 'STALE',
  MISMATCH = 'MISMATCH',
  FAILED = 'FAILED',
}

export interface Asset {
  type: AssetType;
  code?: string; // null for native XLM
  issuer?: string; // null for native XLM
}

export interface WalletBalance {
  id: string;
  walletId: string;
  assetType: AssetType;
  assetCode?: string | null;
  assetIssuer?: string | null;
  balance: string; // Decimal string for precision
  syncStatus: BalanceSyncStatus;
  lastSyncedAt?: Date | null;
  lastSyncedLedger?: number | null;
  lastReconciledAt?: Date | null;
  reconciliationAttempts: number;
  onChainBalance?: string | null;
  mismatchDetectedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceUpdate {
  walletId: string;
  asset: Asset;
  balance: string;
  ledgerSequence: number;
  timestamp: Date;
}

export interface ReconciliationResult {
  walletId: string;
  asset: Asset;
  indexedBalance: string;
  onChainBalance: string;
  matches: boolean;
  difference?: string;
}
