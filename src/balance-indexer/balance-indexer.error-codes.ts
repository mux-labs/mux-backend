import type { BalanceAssetType } from './balance-indexer.model';

/**
 * Stable, typed error codes for the Horizon balance reconciliation surface.
 *
 * Clients (wallets, ops dashboards) branch on these codes, not on
 * human-readable messages. Add new codes; never repurpose an existing one.
 */
export const BalanceIndexerErrorCode = {
  // Validation
  INVALID_INPUT: 'BALANCE_INVALID_INPUT',
  WALLET_NOT_FOUND: 'BALANCE_WALLET_NOT_FOUND',

  // Authz (deny-by-default)
  NOT_AUTHORIZED: 'BALANCE_NOT_AUTHORIZED',
  INSUFFICIENT_ROLE: 'BALANCE_INSUFFICIENT_ROLE',

  // Dependency / fail-closed
  /** Horizon (or the balance store) is unreachable; no write was applied. */
  DEPENDENCY_UNAVAILABLE: 'BALANCE_DEPENDENCY_UNAVAILABLE',

  /** Horizon answered, but the payload could not be trusted or parsed. */
  DEPENDENCY_MALFORMED: 'BALANCE_DEPENDENCY_MALFORMED',

  /** Feature flag is off; the operation is refused rather than silently skipped. */
  FEATURE_FLAG_DISABLED: 'BALANCE_FEATURE_FLAG_DISABLED',

  /** A batch exceeded the maximum number of wallets processed in one run. */
  BATCH_TOO_LARGE: 'BALANCE_BATCH_TOO_LARGE',
} as const;

export type BalanceIndexerErrorCode =
  (typeof BalanceIndexerErrorCode)[keyof typeof BalanceIndexerErrorCode];

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

/**
 * DI token for {@link HorizonBalanceClient}.
 *
 * The service depends on this token rather than the concrete REST client, so a
 * test (or a future RPC-backed client) can be substituted without touching the
 * service.
 */
export const HORIZON_BALANCE_CLIENT = 'HORIZON_BALANCE_CLIENT';

/**
 * DI token for {@link BalanceStore}.
 *
 * The service is bound to this token so the persistence layer can be swapped
 * in tests (an in-memory fake) without constructing a Prisma client.
 */
export const BALANCE_STORE = 'BALANCE_STORE';

/**
 * Narrow persistence port for the balance index.
 *
 * Declared structurally rather than typed as `PrismaService` on purpose: the
 * service only needs these five reads/writes, and depending on the interface
 * keeps it unit-testable without booting Prisma, and keeps the module honest
 * about what it actually touches. `PrismaService` satisfies it structurally.
 */
export interface BalanceStore {
  wallet: {
    findUnique(args: {
      where: { id: string };
      select?: { id: true; publicKey: true };
    }): Promise<{ id: string; publicKey: string } | null>;
    findMany(args: {
      where: { status: string };
      select?: { id: true; publicKey: true };
    }): Promise<Array<{ id: string; publicKey: string }>>;
  };
  walletBalance: {
    findMany(args: {
      where: { walletId: string };
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
    }): Promise<BalanceRow[]>;
    findUnique(args: {
      where: { walletId_assetType_assetCode_assetIssuer: AssetKey };
    }): Promise<BalanceRow | null>;
    count(args: {
      where: { walletId: string; lastSyncedAt: { gte: Date } };
    }): Promise<number>;
    upsert(args: {
      where: { walletId_assetType_assetCode_assetIssuer: AssetKey };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Shape of a persisted balance row.
 *
 * Only the fields this service reads are declared; Prisma returns a superset,
 * which is structurally assignable.
 */
export interface BalanceRow {
  id?: string;
  walletId?: string;
  assetType?: string;
  assetCode?: string | null;
  assetIssuer?: string | null;
  balance?: string;
  syncStatus?: string;
  lastSyncedAt?: Date | null;
  onChainBalance?: string | null;
  mismatchDetectedAt?: Date | null;
}

/** Composite unique-key fields identifying one (wallet, asset) balance row. */
export interface AssetKey {
  walletId: string;
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
}

/**
 * Minimal Horizon surface the indexer depends on.
 *
 * Kept as an explicit port so the reconciliation logic can be unit-tested
 * against a fake, and so a Horizon outage can be simulated deterministically
 * rather than depending on a live network in tests.
 */
export interface HorizonBalanceClient {
  /**
   * Fetch the on-chain balances for an account.
   *
   * Implementations MUST throw on transport failure, timeout, or a non-2xx
   * response — never resolve with a partial or empty list, because the caller
   * treats a resolved value as authoritative and would then overwrite good
   * indexed data with zeroes.
   */
  fetchAccountBalances(accountId: string): Promise<HorizonAccountBalances>;
}

/** Network-scoped view of an account's balances as returned by Horizon. */
export interface HorizonAccountBalances {
  accountId: string;
  /** Ledger sequence the snapshot was taken at. */
  ledger: number;
  balances: Array<{
    assetType: BalanceAssetType;
    assetCode: string | null;
    assetIssuer: string | null;
    /** Balance in the asset's smallest unit, as a string. */
    balance: string;
  }>;
}

/**
 * Env var that gates balance writes (sync/reconcile). Default OFF
 * (fail-closed): without an explicit opt-in, no indexed balance is ever
 * mutated, so a misconfigured deploy cannot corrupt the index.
 */
export const BALANCE_SYNC_ENABLED_ENV = 'BALANCE_SYNC_ENABLED';

/**
 * How long a balance may go without a refresh before `detectStaleBalances`
 * reports it. Configurable so testnet (fast blocks) and mainnet can differ.
 */
export const DEFAULT_BALANCE_STALE_THRESHOLD_MS = 300_000;

/**
 * Upper bound on wallets processed in a single `syncAll`/`reconcileAll` sweep.
 * Bounds the blast radius of a bad deploy and the memory held by one batch.
 */
export const MAX_SWEEP_WALLETS = 500;

/**
 * Minimal Horizon surface the indexer depends on.
 *
 * Kept as an explicit port so the reconciliation logic can be unit-tested
 * against a fake, and so a Horizon outage can be simulated deterministically
 * rather than depending on a live network in tests.
 */
export interface HorizonBalanceClient {
  /**
   * Fetch the on-chain balances for an account.
   *
   * Implementations MUST throw on transport failure, timeout, or a non-2xx
   * response — never resolve with a partial or empty list, because the caller
   * treats a resolved value as authoritative and would then overwrite good
   * indexed data with zeroes.
   */
  fetchAccountBalances(accountId: string): Promise<HorizonAccountBalances>;
}

/** Network-scoped view of an account's balances as returned by Horizon. */
export interface HorizonAccountBalances {
  accountId: string;
  /** Ledger sequence the snapshot was taken at. */
  ledger: number;
  balances: Array<{
    assetType: BalanceAssetType;
    assetCode: string | null;
    assetIssuer: string | null;
    /** Balance in the asset's smallest unit, as a string. */
    balance: string;
  }>;
}

/**
 * Env var that gates balance writes (sync/reconcile). Default OFF
 * (fail-closed): without an explicit opt-in, no indexed balance is ever
 * mutated, so a misconfigured deploy cannot corrupt the index.
 */
export const BALANCE_SYNC_ENABLED_ENV = 'BALANCE_SYNC_ENABLED';

/**
 * How long a balance may go without a refresh before `detectStaleBalances`
 * reports it. Configurable so testnet (fast blocks) and mainnet can differ.
 */
export const DEFAULT_BALANCE_STALE_THRESHOLD_MS = 300_000;

/**
 * Upper bound on wallets processed in a single `syncAll`/`reconcileAll` sweep.
 * Bounds the blast radius of a bad deploy and the memory held by one batch.
 */
export const MAX_SWEEP_WALLETS = 500;
