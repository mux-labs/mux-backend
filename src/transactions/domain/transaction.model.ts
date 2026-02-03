/**
 * Internal Transaction domain model.
 *
 * Transactions are tracked internally for observability, retries, and developer dashboards
 * — independent of Stellar network primitives.
 */

export enum TransactionStatus {
  PENDING = 'PENDING',    // Transaction created but not yet submitted to network
  SUBMITTED = 'SUBMITTED', // Transaction submitted to Stellar network
  CONFIRMED = 'CONFIRMED', // Transaction confirmed on-chain
  FAILED = 'FAILED',      // Transaction failed (rejected, expired, or error)
}

export type TransactionId = string;
export type WalletId = string;

/**
 * Asset information for a transaction
 */
export interface TransactionAsset {
  type: string;    // AssetType enum as string (NATIVE, CREDIT_ALPHANUM4, etc.)
  code?: string | null;   // e.g., "USDC" (null for native XLM)
  issuer?: string | null; // Issuer public key (null for native XLM)
}

/**
 * Stellar network references
 */
export interface StellarNetworkReferences {
  hash?: string | null;   // Stellar transaction hash
  ledger?: number | null; // Ledger sequence number
  fee?: string | null;    // Transaction fee paid (in stroops)
}

/**
 * Transaction domain model
 */
export interface Transaction {
  id: TransactionId;
  
  /** Transaction amount (stored as string for precision) */
  amount: string;
  
  /** Asset information */
  asset: TransactionAsset;
  
  /** Wallet references */
  senderWalletId: WalletId;
  receiverWalletId?: WalletId | null;
  
  /** Lifecycle state */
  status: TransactionStatus;
  
  /** Stellar network references */
  stellarRefs: StellarNetworkReferences;
  
  /** State transition tracking */
  statusChangedAt: Date;
  statusReason?: string | null;
  
  /** Submission tracking */
  submittedAt?: Date | null;
  confirmedAt?: Date | null;
  failedAt?: Date | null;
  
  /** Metadata for future webhooks and analytics */
  metadata?: Record<string, any> | null;
  
  /** Operational metadata */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Explicit, audit-friendly status transition rules.
 * Ensures deterministic and auditable transaction states.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<TransactionStatus, ReadonlySet<TransactionStatus>>
> = {
  [TransactionStatus.PENDING]: new Set([
    TransactionStatus.SUBMITTED,
    TransactionStatus.FAILED,
  ]),
  [TransactionStatus.SUBMITTED]: new Set([
    TransactionStatus.CONFIRMED,
    TransactionStatus.FAILED,
  ]),
  [TransactionStatus.CONFIRMED]: new Set([]), // Terminal state
  [TransactionStatus.FAILED]: new Set([]),    // Terminal state
};

/**
 * Check if a status transition is allowed
 */
export function canTransitionTransactionStatus(
  from: TransactionStatus,
  to: TransactionStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

/**
 * Transition transaction status with proper timestamp tracking
 */
export function transitionTransactionStatus(
  transaction: Transaction,
  to: TransactionStatus,
  statusReason?: string,
  stellarRefs?: Partial<StellarNetworkReferences>,
  at: Date = new Date(),
): Transaction {
  if (transaction.status === to) return transaction;
  
  if (!canTransitionTransactionStatus(transaction.status, to)) {
    throw new Error(
      `Invalid transaction status transition: ${transaction.status} -> ${to}`,
    );
  }
  
  const updates: Partial<Transaction> = {
    status: to,
    statusChangedAt: at,
    updatedAt: at,
  };
  
  // Update status-specific timestamps
  if (to === TransactionStatus.SUBMITTED) {
    updates.submittedAt = at;
  } else if (to === TransactionStatus.CONFIRMED) {
    updates.confirmedAt = at;
  } else if (to === TransactionStatus.FAILED) {
    updates.failedAt = at;
  }
  
  // Update status reason if provided
  if (statusReason !== undefined) {
    updates.statusReason = statusReason;
  }
  
  // Update Stellar network references if provided
  if (stellarRefs) {
    updates.stellarRefs = {
      ...transaction.stellarRefs,
      ...stellarRefs,
    };
  }
  
  return {
    ...transaction,
    ...updates,
  };
}

/**
 * Create a new transaction in PENDING state
 */
export function createTransaction(
  amount: string,
  asset: TransactionAsset,
  senderWalletId: WalletId,
  receiverWalletId?: WalletId | null,
  metadata?: Record<string, any> | null,
  id?: TransactionId,
  at: Date = new Date(),
): Transaction {
  return {
    id: id || crypto.randomUUID(),
    amount,
    asset,
    senderWalletId,
    receiverWalletId: receiverWalletId ?? null,
    status: TransactionStatus.PENDING,
    stellarRefs: {},
    statusChangedAt: at,
    statusReason: null,
    submittedAt: null,
    confirmedAt: null,
    failedAt: null,
    metadata: metadata ?? null,
    createdAt: at,
    updatedAt: at,
  };
}
