/**
 * Domain model for API keys (#942).
 *
 * Kept free of the generated Prisma client so the domain layer does not depend
 * on a database build, and so unit tests can exercise the model offline.
 */

/** Lifecycle states of an API key. Mirrors `ApiKeyStatus` in the schema. */
export enum ApiKeyStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
  SUSPENDED = 'SUSPENDED',
}

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastFour: string;
  projectId: string;
  /**
   * Network this key is scoped to. `null`/`undefined` means "all networks".
   * Enforced by `assertNetworkMatch` (#943).
   */
  network?: 'MAINNET' | 'TESTNET' | null;
  status: ApiKeyStatus;
  expiresAt?: Date;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  gracePeriodEndsAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Developer {
  id: string;
  email: string;
  name?: string | null;
  company?: string | null;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  developerId: string;
  status?: string;
  environment: string;
  rateLimitRpm?: number;
  createdAt?: Date;
  updatedAt?: Date;
  developer?: Developer;
  roles?: string[];
}

/**
 * Validated API key context attached to a request by `ApiKeyGuard`.
 * Never contains the plaintext key or its hash in a log-safe position.
 */
export interface ApiKeyContext {
  apiKey: ApiKey;
  project: Project;
  developer: Developer;
}

/** Alias kept for callers that read `ApiKeyInfo`. */
export type ApiKeyInfo = ApiKeyContext;

/**
 * Stable, typed error codes for the API-key surface.
 *
 * Clients branch on these codes, never on messages. Add new codes; never
 * repurpose an existing one. Codes are deliberately distinguishable so a
 * caller can tell "revoked" from "expired" from "wrong network" without
 * parsing prose.
 */
export const ApiKeyErrorCode = {
  /** No credential was presented at all. */
  UNAUTHORIZED: 'API_KEY_UNAUTHORIZED',

  /** The Authorization header was not a supported scheme/format. */
  INVALID_FORMAT: 'API_KEY_INVALID_FORMAT',

  /** No key matches the presented value. */
  INVALID: 'API_KEY_INVALID',

  /** The key was revoked. Revocation takes effect immediately (#942). */
  REVOKED: 'API_KEY_REVOKED',

  /** The key is suspended by an operator. */
  SUSPENDED: 'API_KEY_SUSPENDED',

  /** The key's `expiresAt` has passed. */
  EXPIRED: 'API_KEY_EXPIRED',

  /** A rotated key's grace period has ended. */
  GRACE_PERIOD_EXPIRED: 'API_KEY_GRACE_PERIOD_EXPIRED',

  /** The key exists but the caller does not own it. */
  FORBIDDEN: 'API_KEY_FORBIDDEN',

  /** Unknown key id on a manage operation. */
  NOT_FOUND: 'API_KEY_NOT_FOUND',

  /** The key store (database) could not be reached. Fail-closed. */
  STORE_UNAVAILABLE: 'API_KEY_STORE_UNAVAILABLE',

  /** The request targets a network the key is not scoped to (#943). */
  NETWORK_MISMATCH: 'NETWORK_MISMATCH',
} as const;

export type ApiKeyErrorCode =
  (typeof ApiKeyErrorCode)[keyof typeof ApiKeyErrorCode];

/**
 * Allowed status transitions.
 *
 * `REVOKED` and `EXPIRED` are terminal: a revoked key can never be reactivated
 * (a new key must be minted), which is what makes revocation immediate and
 * irreversible from a client's point of view.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<ApiKeyStatus, ReadonlySet<ApiKeyStatus>>
> = {
  [ApiKeyStatus.ACTIVE]: new Set([
    ApiKeyStatus.REVOKED,
    ApiKeyStatus.EXPIRED,
    ApiKeyStatus.SUSPENDED,
  ]),
  [ApiKeyStatus.SUSPENDED]: new Set([
    ApiKeyStatus.ACTIVE,
    ApiKeyStatus.REVOKED,
  ]),
  [ApiKeyStatus.EXPIRED]: new Set([]),
  [ApiKeyStatus.REVOKED]: new Set([]),
};

export function canTransitionApiKeyStatus(
  from: ApiKeyStatus,
  to: ApiKeyStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
