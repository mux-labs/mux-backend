import { createHash, timingSafeEqual } from 'crypto';

/**
 * Verification of the maintenance-mode admin secret, with support for
 * zero-downtime rotation (#925).
 *
 * `MAINTENANCE_ADMIN_SECRET` gates `PATCH /v1/maintenance` — the one control
 * that can freeze every write in the deployment. Rotating it naively is an
 * availability incident: the moment the new value is deployed, any operator
 * still holding the old one is locked out of the very endpoint they need to
 * disable maintenance mode.
 *
 * This module implements an **overlap window** rotation:
 *
 * | Env var                          | Meaning                                    |
 * |----------------------------------|--------------------------------------------|
 * | `MAINTENANCE_ADMIN_SECRET`       | Current secret. Always required in prod.   |
 * | `MAINTENANCE_ADMIN_SECRET_PREVIOUS` | Prior secret, accepted during rotation.  |
 * | `MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT` | ISO-8601 instant after which the previous secret stops being accepted. |
 *
 * Invariants (fail-closed, deny-by-default):
 *
 * 1. **Constant-time comparison.** The presented value is compared with
 *    `crypto.timingSafeEqual`, so response timing cannot be used to recover the
 *    secret byte-by-byte.
 * 2. **No expiry, no previous secret accepted.** The previous secret is only
 *    honoured while `..._PREVIOUS_EXPIRES_AT` is in the future. A stale
 *    previous secret left in the environment stops working once the window
 *    closes — an unbounded second credential is a permanent back door.
 * 3. **An unparseable expiry closes the window.** A typo must fail closed, not
 *    silently extend the previous secret's life.
 * 4. **No secret ever leaves this module.** Nothing here logs, returns, or
 *    serializes the configured or presented value; callers get a boolean and
 *    a stable reason code only.
 * 5. **Deny-by-default on misconfiguration.** With no current secret
 *    configured, every verification fails — there is no fallback credential
 *    and no environment that relaxes this.
 */

/** Stable, non-leaking outcomes of a verification attempt. */
export const MAINTENANCE_SECRET_RESULT = {
  /** Presented value matched the current secret. */
  OK: 'OK',
  /** Presented value matched the previous secret inside the overlap window. */
  OK_PREVIOUS: 'OK_PREVIOUS',
  /** No secret configured — deny-by-default. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** No value presented in the `X-Maintenance-Secret` header. */
  MISSING: 'MISSING',
  /** A value was presented but matched neither current nor previous secret. */
  MISMATCH: 'MISMATCH',
  /**
   * The previous secret was presented after its overlap window closed. Kept
   * distinct from `MISMATCH` so operators can spot an unfinished rotation.
   */
  PREVIOUS_EXPIRED: 'PREVIOUS_EXPIRED',
} as const;

export type MaintenanceSecretResult =
  (typeof MAINTENANCE_SECRET_RESULT)[keyof typeof MAINTENANCE_SECRET_RESULT];

/** Current-secret env var. */
export const MAINTENANCE_ADMIN_SECRET_ENV = 'MAINTENANCE_ADMIN_SECRET';

/** Previous-secret env var, honoured only during a rotation window. */
export const MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV =
  'MAINTENANCE_ADMIN_SECRET_PREVIOUS';

/** ISO-8601 instant at which the previous secret stops being accepted. */
export const MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV =
  'MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT';

/** Header carrying the presented secret. */
export const MAINTENANCE_SECRET_HEADER = 'x-maintenance-secret';

/**
 * Stable error code returned when the persisted maintenance state cannot be
 * read. Distinct from `MAINTENANCE_MODE` so an operator can tell "maintenance
 * is on" from "we cannot tell", and act accordingly.
 */
export const MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE =
  'MAINTENANCE_STATE_UNAVAILABLE';

/**
 * Constant-time string comparison that does not leak length through an early
 * return. `timingSafeEqual` requires equal-length buffers, so both values are
 * hashed to a fixed width first — this keeps the comparison constant-time
 * without revealing how long the configured secret is.
 */
export function secretsMatch(presented: string, configured: string): boolean {
  if (typeof presented !== 'string' || typeof configured !== 'string') {
    return false;
  }
  if (presented.length === 0 || configured.length === 0) {
    return false;
  }

  // SHA-256 both sides to a uniform 32-byte length, then compare in
  // constant time. A timing difference now only reveals *that* two values
  // differ, never how many leading bytes matched.
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(configured, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** A verification outcome plus the (secret-free) context for logging. */
export interface MaintenanceSecretVerification {
  /** True only when the caller presented a currently-valid secret. */
  authorized: boolean;
  /** Stable reason code. Safe to log; contains no secret material. */
  result: MaintenanceSecretResult;
  /**
   * True when the caller authenticated with the *previous* secret, i.e. an
   * operator who has not yet been migrated onto the rotated value. Useful for
   * alerting on an unfinished rotation.
   */
  usedPreviousSecret: boolean;
}

/** Minimal request shape needed to read the presented secret. */
export interface MaintenanceSecretRequest {
  headers?: Record<string, unknown>;
}

/**
 * Resolves and verifies the maintenance admin secret.
 *
 * The service is intentionally a plain injectable class with no I/O: the
 * secret comes from the environment (populated by the secret manager), so
 * rotation is a deployment concern and this class only enforces policy.
 */
export class MaintenanceSecretService {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Current secret, or `undefined` when unset. Never logged. */
  get currentSecret(): string | undefined {
    const value = this.env[MAINTENANCE_ADMIN_SECRET_ENV];
    return value && value.length > 0 ? value : undefined;
  }

  /**
   * Previous secret still inside its overlap window, if any.
   *
   * `now` is injectable so callers (and tests) evaluate the window against an
   * explicit instant rather than wall-clock drift. A method rather than a
   * getter because the window depends on the current time.
   */
  activePreviousSecret(now: Date = new Date()): string | undefined {
    const previous = this.env[MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV];
    if (!previous || previous.length === 0) {
      return undefined;
    }
    return this.isPreviousSecretActive(now) ? previous : undefined;
  }

  /**
   * Whether the rotation window is still open.
   *
   * Fail-closed: with no expiry configured, or an unparseable one, the window
   * is closed and the previous secret is not accepted.
   */
  isPreviousSecretActive(now: Date = new Date()): boolean {
    const raw = this.env[MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV];
    if (!raw || raw.trim().length === 0) {
      return false;
    }

    const expiresAt = Date.parse(raw);
    if (Number.isNaN(expiresAt)) {
      return false;
    }

    return now.getTime() < expiresAt;
  }

  /**
   * Verify a presented secret against the current value and — while the
   * rotation window is open — the previous one.
   *
   * Order matters: the current secret is checked first so the common case
   * costs one comparison, and a previous-secret match is reported distinctly
   * so operators can see the rotation is incomplete.
   */
  verify(
    request: MaintenanceSecretRequest | undefined,
    now: Date = new Date(),
  ): MaintenanceSecretVerification {
    const current = this.currentSecret;
    if (!current) {
      // Deny-by-default: no configured secret means no authorized caller.
      return {
        authorized: false,
        result: MAINTENANCE_SECRET_RESULT.NOT_CONFIGURED,
        usedPreviousSecret: false,
      };
    }

    const presented = this.readPresentedSecret(request);
    if (!presented) {
      return {
        authorized: false,
        result: MAINTENANCE_SECRET_RESULT.MISSING,
        usedPreviousSecret: false,
      };
    }

    if (secretsMatch(presented, current)) {
      return {
        authorized: true,
        result: MAINTENANCE_SECRET_RESULT.OK,
        usedPreviousSecret: false,
      };
    }

    const previous = this.env[MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV];
    if (previous && previous.length > 0 && secretsMatch(presented, previous)) {
      const stillActive = this.isPreviousSecretActive(now);
      return {
        authorized: stillActive,
        result: stillActive
          ? MAINTENANCE_SECRET_RESULT.OK_PREVIOUS
          : MAINTENANCE_SECRET_RESULT.PREVIOUS_EXPIRED,
        usedPreviousSecret: stillActive,
      };
    }

    return {
      authorized: false,
      result: MAINTENANCE_SECRET_RESULT.MISMATCH,
      usedPreviousSecret: false,
    };
  }

  /**
   * Ops-safe snapshot for logs/metrics. Reports only whether rotation is in
   * progress and how long the window has left — never any secret value.
   */
  rotationSnapshot(now: Date = new Date()): Record<string, string | boolean> {
    const previousConfigured =
      (this.env[MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV]?.length ?? 0) > 0;
    const windowOpen = this.isPreviousSecretActive(now);
    const expiresAt =
      this.env[MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV] ?? null;

    return {
      maintenanceSecretConfigured: this.currentSecret !== undefined,
      maintenancePreviousSecretConfigured: previousConfigured,
      maintenanceRotationWindowOpen: windowOpen,
      maintenanceRotationExpiresAt: windowOpen
        ? (expiresAt as string)
        : 'closed',
    };
  }

  /**
   * Extract the presented secret from the request headers. Header lookup is
   * case-insensitive because Node lower-cases inbound header names, but an
   * explicitly-cased key is honoured too. Returns `undefined` for an absent
   * or empty value so a blank header is a MISSING, not a MISMATCH.
   */
  private readPresentedSecret(
    request: MaintenanceSecretRequest | undefined,
  ): string | undefined {
    const headers = request?.headers;
    if (!headers) {
      return undefined;
    }

    const raw =
      headers[MAINTENANCE_SECRET_HEADER] ??
      headers['X-Maintenance-Secret'] ??
      headers['X-MAINTENANCE-SECRET'];

    // A repeated header arrives as an array; only the first value is honoured.
    const candidate: unknown = Array.isArray(raw) ? raw[0] : raw;
    if (typeof candidate !== 'string') {
      return undefined;
    }

    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
