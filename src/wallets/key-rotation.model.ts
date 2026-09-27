/**
 * Stable, typed error codes for wallet `keyVersion` rotation.
 *
 * These are part of the custody contract documented in
 * `docs/migration-recovery-runbook.md`. Clients and runbooks branch on these
 * codes, so they must stay stable. Add new codes; never repurpose an existing
 * one.
 */
export const KeyRotationErrorCode = {
  // Validation
  INVALID_INPUT: 'KEY_ROTATION_INVALID_INPUT',

  // Not found
  WALLET_NOT_FOUND: 'KEY_ROTATION_WALLET_NOT_FOUND',

  // Fail-closed decrypt / version handling
  /**
   * The stored envelope could not be decrypted. The operation is refused —
   * never fall back to plaintext or an older key.
   */
  DECRYPT_FAILED: 'KEY_ROTATION_DECRYPT_FAILED',

  /**
   * The wallet's `keyVersion` is outside the supported set. Refused rather
   * than assumed to be "the latest".
   */
  VERSION_UNSUPPORTED: 'KEY_ROTATION_VERSION_UNSUPPORTED',

  /**
   * A rotation would move `keyVersion` backwards. Rotation is monotonic.
   */
  VERSION_CONFLICT: 'KEY_ROTATION_VERSION_CONFLICT',

  // Authz (deny-by-default)
  NOT_AUTHORIZED: 'KEY_ROTATION_NOT_AUTHORIZED',
  INSUFFICIENT_ROLE: 'KEY_ROTATION_INSUFFICIENT_ROLE',

  // Dependency / fail-closed
  DEPENDENCY_UNAVAILABLE: 'KEY_ROTATION_DEPENDENCY_UNAVAILABLE',

  /** The rotation kill-switch is off; the operation is refused. */
  FEATURE_FLAG_DISABLED: 'KEY_ROTATION_FEATURE_FLAG_DISABLED',

  /**
   * A replayed rotation carrying the same idempotency key but a different
   * target version.
   */
  IDEMPOTENCY_CONFLICT: 'KEY_ROTATION_IDEMPOTENCY_CONFLICT',
} as const;

export type KeyRotationErrorCode =
  (typeof KeyRotationErrorCode)[keyof typeof KeyRotationErrorCode];

/**
 * Env var that gates key rotation. Default OFF (fail-closed): a wallet's key
 * material is only ever rewritten when an operator has explicitly opted in.
 */
export const KEY_ROTATION_ENABLED_ENV = 'KEY_ROTATION_ENABLED';

/**
 * Key versions this build can read and write.
 *
 * This is a closed set on purpose. A version outside it is refused with
 * `KEY_ROTATION_VERSION_UNSUPPORTED` rather than guessed at — treating an
 * unknown version as "the latest" is how a rotation ends up destroying the
 * only copy of a key. Extend the set when the derivation scheme changes.
 */
export const SUPPORTED_KEY_VERSIONS: readonly number[] = [1, 2];

/** The highest version this build can rotate to. */
export const CURRENT_KEY_VERSION = 2;

/** How long a recorded rotation stays replayable, in ms. */
export const ROTATION_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Authenticated principal for a key operation.
 *
 * Rotation is one of the most privileged surfaces in the system: it rewrites
 * the material that controls a wallet's funds. It is therefore owner/guardian
 * only — a delegate may read key metadata but may not rotate.
 */
export interface KeyRotationActor {
  subjectId: string;
  role: 'owner' | 'delegate' | 'guardian' | 'api-key' | 'jwt';
  correlationId: string;
}

/** Metadata about a wallet's key, safe to return to an authorized caller. */
export interface WalletKeyMetadata {
  walletId: string;
  /** Key algorithm/derivation scheme version. Never the key material. */
  keyVersion: number;
  /** Envelope/KMS format version. Distinct from `keyVersion`. */
  encryptionVersion: number;
  /** Monotonic counter incremented on every secret rotation. */
  secretVersion: number;
  network: string;
  /** True when `keyVersion` is in {@link SUPPORTED_KEY_VERSIONS}. */
  supported: boolean;
  /** True when the wallet is already on {@link CURRENT_KEY_VERSION}. */
  upToDate: boolean;
}

/** Result of a successful rotation. Carries no key material. */
export interface KeyRotationResult {
  walletId: string;
  previousKeyVersion: number;
  keyVersion: number;
  secretVersion: number;
  rotatedAt: Date;
  /** False when an idempotent replay returned the earlier result. */
  applied: boolean;
}
