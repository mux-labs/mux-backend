/**
 * Supported key types for key management operations.
 * Each type maps to a specific cryptographic algorithm and provider.
 */
export enum KeyType {
  /** Stellar/Soroban Ed25519 keys (used for wallets) */
  STELLAR_ED25519 = 'STELLAR_ED25519',

  /** Ethereum secp256k1 keys (future) */
  ETHEREUM_SECP256K1 = 'ETHEREUM_SECP256K1',

  /** AWS KMS keys (future) */
  AWS_KMS = 'AWS_KMS',

  /** Hardware Security Module keys (future) */
  HSM = 'HSM',
}

/**
 * Key operation types for audit logging and statistics.
 */
export enum KeyOperation {
  /** Key pair generation */
  GENERATE = 'GENERATE',

  /** Digital signature */
  SIGN = 'SIGN',

  /** Key validation/verification */
  VALIDATE = 'VALIDATE',

  /** Key rotation */
  ROTATE = 'ROTATE',

  /** Key access/read */
  ACCESS = 'ACCESS',

  /** Key re-encryption */
  RE_ENCRYPT = 'RE_ENCRYPT',
}

/**
 * Result of a key generation operation.
 */
export interface KeyGenerationResult {
  /** The public key (safe to log and return) */
  publicKey: string;

  /** The encrypted private key material */
  encryptedData: string;

  /** The key type that was generated */
  keyType: KeyType;

  /** The encryption version used */
  encryptionVersion: number;

  /** The key version (for rotation tracking) */
  keyVersion: number;
}

/**
 * Result of a sign operation.
 */
export interface SignResult {
  /** The base64-encoded signature */
  signature: string;

  /** The public key that was used */
  publicKey: string;

  /** The algorithm used */
  algorithm: string;

  /** ISO timestamp of the operation */
  timestamp: string;
}

/**
 * Result of a validate operation.
 */
export interface ValidateResult {
  /** Whether the key pair is valid */
  valid: boolean;
}

/**
 * Result of a rotate operation.
 */
export interface RotateResult {
  /** The predecessor wallet ID */
  predecessorWalletId: string;

  /** The successor wallet ID */
  successorWalletId: string;

  /** The successor public key */
  successorPublicKey: string;
}

/**
 * Audit log entry for key operations.
 */
export interface KeyAuditLogEntry {
  /** Unique ID for this audit entry */
  id: string;

  /** The operation type */
  operation: KeyOperation;

  /** The public key (safe to log) */
  publicKey: string;

  /** The key type */
  keyType: KeyType;

  /** ISO timestamp of the operation */
  timestamp: string;

  /** Whether the operation succeeded */
  success: boolean;

  /** Error message if failed (sanitized) */
  error?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;

  /** Correlation ID from the request */
  requestId?: string;
}

/**
 * Parameters for filtering audit logs.
 */
export interface AuditLogQueryParams {
  /** Maximum number of entries to return */
  limit?: number;

  /** Filter by operation type */
  operation?: KeyOperation;

  /** Filter by key type */
  keyType?: KeyType;

  /** Filter by success status */
  success?: boolean;

  /** Start date (ISO string) */
  startDate?: string;

  /** End date (ISO string) */
  endDate?: string;
}