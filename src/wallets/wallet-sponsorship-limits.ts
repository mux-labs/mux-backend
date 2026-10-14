/**
 * Stable, typed error codes for wallet-creation sponsorship limits.
 *
 * Clients and operators branch on these codes, not on message text.
 * Add new codes; never repurpose an existing one.
 */
export const WalletSponsorshipLimitErrorCode = {
  /** The caller has exhausted their per-user sponsored-wallet allowance. */
  PER_USER_LIMIT_REACHED: 'WALLET_SPONSORSHIP_PER_USER_LIMIT_REACHED',
  /** The deployment-wide sponsored-wallet allowance is exhausted. */
  GLOBAL_LIMIT_REACHED: 'WALLET_SPONSORSHIP_GLOBAL_LIMIT_REACHED',
  /** Sponsorship is switched off, so no wallet may be sponsored right now. */
  SPONSORSHIP_DISABLED: 'WALLET_SPONSORSHIP_DISABLED',
  /** The backing store is unreachable; the request is refused, not allowed. */
  DEPENDENCY_UNAVAILABLE: 'WALLET_SPONSORSHIP_DEPENDENCY_UNAVAILABLE',
} as const;

export type WalletSponsorshipLimitErrorCode =
  (typeof WalletSponsorshipLimitErrorCode)[keyof typeof WalletSponsorshipLimitErrorCode];

/**
 * Default number of sponsored wallet creations allowed per user per window.
 *
 * Wallet creation spends sponsor resources (the base-reserve XLM the sponsor
 * fronts, plus the transaction fee). Without a per-user cap, a single caller
 * can loop create requests across many user ids and drain the sponsor account,
 * which is a money-path availability incident rather than a nuisance error.
 */
export const DEFAULT_MAX_SPONSORED_WALLETS_PER_USER = 5;

/** Default deployment-wide cap per window. */
export const DEFAULT_MAX_SPONSORED_WALLETS_GLOBAL = 1_000;

/** Default accounting window, in milliseconds (24 hours). */
export const DEFAULT_SPONSORSHIP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Env vars. All are optional; every one falls back to a safe default. */
export const WALLET_SPONSORSHIP_ENABLED_ENV = 'WALLET_SPONSORSHIP_ENABLED';
export const WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV =
  'WALLET_MAX_SPONSORED_WALLETS_PER_USER';
export const WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV =
  'WALLET_MAX_SPONSORED_WALLETS_GLOBAL';
export const WALLET_SPONSORSHIP_WINDOW_MS_ENV = 'WALLET_SPONSORSHIP_WINDOW_MS';

/** Resolved, validated limits. */
export interface WalletSponsorshipLimits {
  /** Whether sponsored wallet creation is permitted at all (kill-switch). */
  enabled: boolean;
  /** Per-user cap within the window. */
  maxPerUser: number;
  /** Deployment-wide cap within the window. */
  maxGlobal: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Reads a positive integer, falling back to `fallback` for anything unusable.
 *
 * Fail-closed on the *limit* side: a typo, an empty string, a zero, or a
 * negative must never widen the allowance. An unparsable value keeps the
 * default cap rather than disabling the control.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves sponsorship limits from environment values.
 *
 * ## Invariants
 *
 * 1. **Sponsorship is opt-out, not opt-in.** Unset means *enabled* with the
 *    default caps. A deploy that never sets the variables is still protected,
 *    which is the safe direction: the failure mode of a missing variable should
 *    be "default caps", not "no caps".
 * 2. **A cap is never widened by a bad value.** An unparsable, zero, or
 *    negative cap falls back to the default rather than becoming unlimited.
 * 3. **The kill-switch only ever removes.** Setting
 *    `WALLET_SPONSORSHIP_ENABLED=false` refuses sponsored creation; there is no
 *    value of this flag that removes the caps while continuing to sponsor.
 */
export function resolveSponsorshipLimits(
  env: NodeJS.ProcessEnv = process.env,
): WalletSponsorshipLimits {
  const rawEnabled = env[WALLET_SPONSORSHIP_ENABLED_ENV];
  const enabled =
    rawEnabled === undefined || rawEnabled.trim() === ''
      ? true
      : !['false', '0', 'off', 'no'].includes(rawEnabled.trim().toLowerCase());

  return {
    enabled,
    maxPerUser: positiveInt(
      env[WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV],
      DEFAULT_MAX_SPONSORED_WALLETS_PER_USER,
    ),
    maxGlobal: positiveInt(
      env[WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV],
      DEFAULT_MAX_SPONSORED_WALLETS_GLOBAL,
    ),
    windowMs: positiveInt(
      env[WALLET_SPONSORSHIP_WINDOW_MS_ENV],
      DEFAULT_SPONSORSHIP_WINDOW_MS,
    ),
  };
}

/** Usage counters for the current window. */
export interface SponsorshipUsage {
  /** Sponsored creations attributed to each user in the window. */
  perUser: ReadonlyMap<string, number>;
  /** Total sponsored creations in the window. */
  total: number;
  /** When the window started, epoch ms. */
  windowStartedAt: number;
}

/** Internal, mutable form of {@link SponsorshipUsage}. */
interface MutableUsage {
  perUser: Map<string, number>;
  total: number;
  windowStartedAt: number;
}

/** Outcome of {@link WalletSponsorshipLimiter.assertWithinLimits}. */
export interface SponsorshipDecision {
  allowed: true;
  limits: WalletSponsorshipLimits;
  /** Usage after the decision, for logging. */
  usageAfter: SponsorshipUsage;
}

/** Empty usage for a fresh window. */
function emptyUsage(now: number = Date.now()): MutableUsage {
  return { perUser: new Map(), total: 0, windowStartedAt: now };
}

/**
 * Enforces the per-user and deployment-wide caps on sponsored wallet creation.
 *
 * The counter is held in memory, which matches the orchestrator's existing
 * in-process idempotency design: it bounds a single deploy's exposure, not a
 * fleet-wide total. A multi-replica deployment therefore enforces the cap per
 * replica. That is documented rather than papered over — the durable, exactly-once
 * version needs a shared counter, which is a schema change and out of scope here.
 *
 * ## Invariants
 *
 * 1. **Fail-closed on the backing store.** A store failure raises
 *    `WALLET_SPONSORSHIP_DEPENDENCY_UNAVAILABLE` and refuses the request. It
 *    never falls through to "allowed", because a counter that cannot be read is
 *    indistinguishable from a counter that is not being enforced.
 * 2. **Check and consume are one step.** `assertWithinLimits` increments on
 *    success, so two concurrent callers cannot both read "4 used" and both be
 *    admitted against a cap of 5.
 * 3. **Replay does not consume budget.** A request that resolves to an existing
 *    wallet or an idempotency replay spends no sponsor resources, so the caller
 *    must not call this for those paths. Doing so would let a retried request
 *    exhaust a user's allowance.
 * 4. **The window rolls forward.** Once the window elapses, usage resets, so a
 *    long outage does not permanently block wallet creation.
 */
export class WalletSponsorshipLimiter {
  private usage: MutableUsage;

  constructor(
    private readonly limits: WalletSponsorshipLimits = resolveSponsorshipLimits(),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.usage = emptyUsage(this.now());
  }

  /** Current usage, after rolling the window forward if it has elapsed. */
  currentUsage(): SponsorshipUsage {
    this.rollWindowIfElapsed();
    return this.usage;
  }

  /**
   * Admits a sponsored wallet creation for `userId`, or throws.
   *
   * @throws Error with a `code` from {@link WalletSponsorshipLimitErrorCode}.
   */
  assertWithinLimits(userId: string): SponsorshipDecision {
    this.rollWindowIfElapsed();

    if (!this.limits.enabled) {
      throw sponsorshipError(
        WalletSponsorshipLimitErrorCode.SPONSORSHIP_DISABLED,
        'Sponsored wallet creation is disabled',
      );
    }

    if (typeof userId !== 'string' || userId.trim().length === 0) {
      throw sponsorshipError(
        WalletSponsorshipLimitErrorCode.DEPENDENCY_UNAVAILABLE,
        'Sponsorship usage could not be attributed to a user',
      );
    }

    // Invariant 2: check and consume together, so two concurrent callers cannot
    // both observe "one slot left" and both take it.
    const used = this.usage.perUser.get(userId) ?? 0;
    if (used >= this.limits.maxPerUser) {
      throw sponsorshipError(
        WalletSponsorshipLimitErrorCode.PER_USER_LIMIT_REACHED,
        `Sponsored wallet limit reached for this user (${this.limits.maxPerUser} per window)`,
      );
    }
    if (this.usage.total >= this.limits.maxGlobal) {
      throw sponsorshipError(
        WalletSponsorshipLimitErrorCode.GLOBAL_LIMIT_REACHED,
        `Deployment sponsored wallet limit reached (${this.limits.maxGlobal} per window)`,
      );
    }

    this.usage.perUser.set(userId, used + 1);
    this.usage.total += 1;

    return { allowed: true, limits: this.limits, usageAfter: this.usage };
  }

  /** Resets usage. Intended for tests and for an operator-driven flush. */
  reset(): void {
    this.usage = emptyUsage(this.now());
  }

  private rollWindowIfElapsed(): void {
    if (this.now() - this.usage.windowStartedAt >= this.limits.windowMs) {
      this.usage = emptyUsage(this.now());
    }
  }
}

/** Builds an Error carrying a stable, machine-readable `code`. */
export function sponsorshipError(
  code: WalletSponsorshipLimitErrorCode,
  message: string,
): Error {
  const err = new Error(message) as Error & {
    code: WalletSponsorshipLimitErrorCode;
  };
  err.code = code;
  return err;
}
