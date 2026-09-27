// Manual mock for the generated Prisma client.
// Used in unit tests to avoid requiring a real database connection.
//
// PrismaClient is mocked so tests never open a DB connection.
// Enum values are inlined here so that runtime comparisons
// (e.g. status === RefreshTokenStatus.ACTIVE) work in tests without
// requiring a real database or a circular import from the generated folder.

export const PrismaClient = jest.fn().mockImplementation(() => ({
  $connect: jest.fn(),
  $disconnect: jest.fn(),
  $transaction: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Inlined enums — keep in sync with prisma/schema.prisma
// ---------------------------------------------------------------------------

export const RefreshTokenStatus = {
  ACTIVE: 'ACTIVE',
  ROTATED: 'ROTATED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;
export type RefreshTokenStatus =
  (typeof RefreshTokenStatus)[keyof typeof RefreshTokenStatus];

export const ApiKeyStatus = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type ApiKeyStatus = (typeof ApiKeyStatus)[keyof typeof ApiKeyStatus];

export const WalletStatus = {
  PROVISIONING: 'PROVISIONING',
  ACTIVE: 'ACTIVE',
  ROTATING: 'ROTATING',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
  COMPROMISED: 'COMPROMISED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type WalletStatus = (typeof WalletStatus)[keyof typeof WalletStatus];

export const WalletNetwork = {
  MAINNET: 'MAINNET',
  TESTNET: 'TESTNET',
} as const;
export type WalletNetwork = (typeof WalletNetwork)[keyof typeof WalletNetwork];

export const UserStatus = {
  PROVISIONING: 'PROVISIONING',
  ACTIVE: 'ACTIVE',
  RECOVERY_PENDING: 'RECOVERY_PENDING',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const PaymentStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const RecoveryStatus = {
  PENDING: 'PENDING',
  IN_REVIEW: 'IN_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type RecoveryStatus =
  (typeof RecoveryStatus)[keyof typeof RecoveryStatus];

export const TransactionStatus = {
  PENDING: 'PENDING',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
} as const;
export type TransactionStatus =
  (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const AssetType = {
  NATIVE: 'NATIVE',
  CREDIT_ALPHANUM4: 'CREDIT_ALPHANUM4',
  CREDIT_ALPHANUM12: 'CREDIT_ALPHANUM12',
  LIQUIDITY_POOL_SHARES: 'LIQUIDITY_POOL_SHARES',
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

export const BalanceSyncStatus = {
  SYNCED: 'SYNCED',
  SYNCING: 'SYNCING',
  STALE: 'STALE',
  MISMATCH: 'MISMATCH',
  FAILED: 'FAILED',
} as const;
export type BalanceSyncStatus =
  (typeof BalanceSyncStatus)[keyof typeof BalanceSyncStatus];

export const LimitPeriod = {
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  MONTHLY: 'MONTHLY',
} as const;
export type LimitPeriod = (typeof LimitPeriod)[keyof typeof LimitPeriod];

export const KeyOperation = {
  GENERATE: 'GENERATE',
  SIGN: 'SIGN',
  ROTATE: 'ROTATE',
  REVOKE: 'REVOKE',
  ACCESS: 'ACCESS',
} as const;
export type KeyOperation = (typeof KeyOperation)[keyof typeof KeyOperation];

export const HorizonImportStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type HorizonImportStatus =
  (typeof HorizonImportStatus)[keyof typeof HorizonImportStatus];

export const ChangeType = {
  ADDED: 'ADDED',
  CHANGED: 'CHANGED',
  DEPRECATED: 'DEPRECATED',
  REMOVED: 'REMOVED',
  FIXED: 'FIXED',
  SECURITY: 'SECURITY',
} as const;
export type ChangeType = (typeof ChangeType)[keyof typeof ChangeType];

export const ChangeCategory = {
  WALLETS: 'WALLETS',
  PAYMENTS: 'PAYMENTS',
  LIMITS: 'LIMITS',
  RECOVERY: 'RECOVERY',
  AUTHENTICATION: 'AUTHENTICATION',
  WEBHOOKS: 'WEBHOOKS',
  GENERAL: 'GENERAL',
} as const;
export type ChangeCategory =
  (typeof ChangeCategory)[keyof typeof ChangeCategory];

// $Enums namespace (mirrors the generated client's barrel export)
export const $Enums = {
  RefreshTokenStatus,
  ApiKeyStatus,
  WalletStatus,
  WalletNetwork,
  UserStatus,
  PaymentStatus,
  RecoveryStatus,
  TransactionStatus,
  AssetType,
  BalanceSyncStatus,
  LimitPeriod,
  KeyOperation,
  HorizonImportStatus,
  ChangeType,
  ChangeCategory,
};
