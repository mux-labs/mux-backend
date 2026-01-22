/**
 * Internal Wallet domain model (chain-agnostic).
 *
 * Wallets are "invisible" to end users but must be tracked for custody,
 * recovery, rotation, and auditing.
 */

export enum WalletNetwork {
  MAINNET = 'MAINNET',
  TESTNET = 'TESTNET',
}

export enum WalletStatus {
  PROVISIONING = 'PROVISIONING',
  ACTIVE = 'ACTIVE',
  ROTATING = 'ROTATING',
  SUSPENDED = 'SUSPENDED',
  DISABLED = 'DISABLED',
  COMPROMISED = 'COMPROMISED',
}

export type WalletId = string;

export interface Wallet {
  id: WalletId;
  userId: string;

  /** Chain-agnostic public identifier (address/public key). */
  publicKey: string;

  /** Chain-agnostic encrypted secret material (envelope/serialized payload). */
  encryptedSecret: string;

  /** Supports future crypto upgrades (KMS provider, envelope format, etc.). */
  encryptionVersion: number;

  /** Supports rotation by incrementing secret material while preserving history. */
  secretVersion: number;

  /** Mainnet/testnet separation. */
  network: WalletNetwork;

  /** Internal lifecycle status. */
  status: WalletStatus;
  statusReason?: string | null;
  statusChangedAt: Date;

  /** Rotation lineage (if this wallet is a successor). */
  rotatedFromId?: WalletId | null;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Explicit, audit-friendly status transition rules.
 * Keep this strict to avoid accidental reactivation after compromise/disable.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<WalletStatus, ReadonlySet<WalletStatus>>> = {
  [WalletStatus.PROVISIONING]: new Set([WalletStatus.ACTIVE, WalletStatus.SUSPENDED, WalletStatus.DISABLED]),
  [WalletStatus.ACTIVE]: new Set([
    WalletStatus.ROTATING,
    WalletStatus.SUSPENDED,
    WalletStatus.DISABLED,
    WalletStatus.COMPROMISED,
  ]),
  [WalletStatus.ROTATING]: new Set([WalletStatus.ACTIVE, WalletStatus.SUSPENDED, WalletStatus.DISABLED, WalletStatus.COMPROMISED]),
  [WalletStatus.SUSPENDED]: new Set([WalletStatus.ACTIVE, WalletStatus.DISABLED, WalletStatus.COMPROMISED]),
  [WalletStatus.DISABLED]: new Set([]),
  [WalletStatus.COMPROMISED]: new Set([]),
};

export function canTransitionWalletStatus(from: WalletStatus, to: WalletStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionWalletStatus(
  wallet: Wallet,
  to: WalletStatus,
  statusReason?: string,
  at: Date = new Date(),
): Wallet {
  if (wallet.status === to) return wallet;
  if (!canTransitionWalletStatus(wallet.status, to)) {
    throw new Error(`Invalid wallet status transition: ${wallet.status} -> ${to}`);
  }
  return {
    ...wallet,
    status: to,
    statusReason: statusReason ?? null,
    statusChangedAt: at,
    updatedAt: at,
  };
}

