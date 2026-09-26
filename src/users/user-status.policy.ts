import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * User-status policy for money paths (#941).
 *
 * The `UserStatus` enum exists in the database (migration
 * `20260831000001_add_user_status_enum`) but nothing enforced it, so a
 * suspended account could still create wallets and move funds. This module is
 * the single, pure source of truth for "may this account transact?".
 *
 * Invariants:
 * 1. **Deny-by-default on the listed statuses.** `SUSPENDED` and `DISABLED`
 *    block every operation. They are operational holds, not preferences.
 * 2. **No client input.** The status is read from the server-side user record;
 *    a body/query/header field can never influence the decision.
 * 3. **Deterministic.** Pure function of (status, operation) — no clock, no
 *    randomness, no I/O — so it is fully unit-testable and reviewable.
 * 4. **Stable codes.** Clients branch on `UserStatusErrorCode`, not messages.
 *    A caller can distinguish suspended from disabled (different remediation).
 */

/** Operations that must refuse a blocked account. */
export type UserOperation = 'wallet_create' | 'payment';

/**
 * Stable, typed error codes for user-status denials.
 *
 * Add new codes; never repurpose an existing one.
 */
export const UserStatusErrorCode = {
  /** The account is on an operational hold. Reversible. */
  USER_SUSPENDED: 'USER_SUSPENDED',

  /** The account is permanently disabled. */
  USER_DISABLED: 'USER_DISABLED',

  /** The account is mid-recovery; spends are held until it completes. */
  USER_RECOVERY_PENDING: 'USER_RECOVERY_PENDING',

  /** No such user. Deny rather than assume an unprovisioned caller. */
  USER_NOT_FOUND: 'USER_NOT_FOUND',

  /** The status is not one of the enum members. Fail-closed. */
  USER_STATUS_UNKNOWN: 'USER_STATUS_UNKNOWN',

  /** The status could not be read (dependency outage). Fail-closed. */
  USER_STATUS_UNAVAILABLE: 'USER_STATUS_UNAVAILABLE',
} as const;

export type UserStatusErrorCode =
  (typeof UserStatusErrorCode)[keyof typeof UserStatusErrorCode];

/** Minimal, ops-safe view of the account needed to make the decision. */
export interface UserStatusSubject {
  userId: string;
  status: string;
}

/**
 * Statuses refused per operation.
 *
 * - `wallet_create`: an operational hold must not be able to mint a new
 *   custody key.
 * - `payment`: same holds, plus `RECOVERY_PENDING` — while a recovery is in
 *   flight the account is not a trustworthy spender.
 */
export const BLOCKED_USER_STATUSES: Readonly<
  Record<UserOperation, readonly string[]>
> = {
  wallet_create: ['SUSPENDED', 'DISABLED'],
  payment: ['SUSPENDED', 'DISABLED', 'RECOVERY_PENDING'],
} as const;

const STATUS_TO_ERROR_CODE: Readonly<Record<string, UserStatusErrorCode>> = {
  SUSPENDED: UserStatusErrorCode.USER_SUSPENDED,
  DISABLED: UserStatusErrorCode.USER_DISABLED,
  RECOVERY_PENDING: UserStatusErrorCode.USER_RECOVERY_PENDING,
};

/**
 * The complete `UserStatus` enum as it exists after migration
 * `20260831000001_add_user_status_enum`.
 *
 * Anything outside this set is a value the application does not understand,
 * and an unrecognised account status is never evidence of a healthy account.
 */
const KNOWN_USER_STATUSES: ReadonlySet<string> = new Set([
  'PROVISIONING',
  'ACTIVE',
  'RECOVERY_PENDING',
  'SUSPENDED',
  'DISABLED',
]);

/** Normalises a status for comparison; unknown values are never allowed. */
function normalizeStatus(status: unknown): string {
  return typeof status === 'string' ? status.trim().toUpperCase() : '';
}

/**
 * Stable error code for a blocked (user, operation) pair, or `null` when the
 * account may proceed.
 */
export function userBlockedErrorCode(
  subject: Pick<UserStatusSubject, 'status'>,
  operation: UserOperation,
): UserStatusErrorCode | null {
  const status = normalizeStatus(subject?.status);

  if (BLOCKED_USER_STATUSES[operation].includes(status)) {
    return STATUS_TO_ERROR_CODE[status] ?? UserStatusErrorCode.USER_DISABLED;
  }

  // Fail closed: a status the app does not recognise (a typo, a half-applied
  // migration) is refused rather than assumed harmless.
  if (!KNOWN_USER_STATUSES.has(status)) {
    return UserStatusErrorCode.USER_STATUS_UNKNOWN;
  }

  return null;
}

/** Whether the account is currently blocked for the operation. */
export function isUserBlocked(
  subject: Pick<UserStatusSubject, 'status'>,
  operation: UserOperation,
): boolean {
  return userBlockedErrorCode(subject, operation) !== null;
}

/**
 * Throws unless the account may perform `operation`.
 *
 * @throws ForbiddenException 403 with a stable `UserStatusErrorCode` when the
 *   account is suspended/disabled (or mid-recovery for a payment).
 *
 * The message never contains the user's data beyond the id it was called with,
 * and the correlation id is echoed so ops can join the denial to the request.
 */
export function assertUserCanTransact(
  subject: UserStatusSubject,
  operation: UserOperation,
  correlationId?: string,
): void {
  const code = userBlockedErrorCode(subject, operation);

  if (!code) {
    return;
  }

  throw new ForbiddenException({
    code,
    message:
      `User ${subject.userId} cannot perform ${operation}: ` +
      `account status is ${normalizeStatus(subject.status)}`,
    correlationId,
  });
}

/** 404 for a user id that does not resolve. Deny-by-default, never guess. */
export function userNotFound(userId: string, correlationId?: string) {
  return new NotFoundException({
    code: UserStatusErrorCode.USER_NOT_FOUND,
    message: `User ${userId} not found`,
    correlationId,
  });
}
