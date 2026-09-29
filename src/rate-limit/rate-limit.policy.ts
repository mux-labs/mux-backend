/**
 * Rate-limit tiers for the auth and payments surfaces (#926).
 *
 * The per-API-key `RATE_LIMIT_RPM` and the per-developer quota are throughput
 * budgets, not abuse controls. This module defines the **tier** that decides
 * which budget a given request draws from, so the two most abuse-prone
 * surfaces are bounded independently of tenant configuration:
 *
 * | Tier       | Surface                         | Keyed by   |
 * |------------|---------------------------------|------------|
 * | `auth`     | `/auth/*` credential endpoints  | client IP  |
 * | `payments` | `/v1/payments*`, money movement | API key    |
 * | `default`  | everything else                 | API key    |
 *
 * Invariants:
 *
 * 1. **Deny-by-default on misconfiguration.** An unparseable or non-positive
 *    limit resolves to the tier's built-in default, never to "unlimited" and
 *    never to zero. A deployment with no configuration still gets protection.
 * 2. **Stricter tiers can only tighten.** A `payments` or `auth` override is
 *    clamped to the resolved `default` ceiling, so a typo cannot open the money
 *    path by raising its own limit. Each tier reads only its **own** env vars —
 *    no tier's override is inherited by another, so loosening the money path
 *    cannot widen the rest of the API.
 * 3. **IP-keyed auth tier.** Credential endpoints are reached before an API
 *    key exists, so they are keyed by client IP — otherwise credential
 *    stuffing from one host would be unthrottled.
 * 4. **Stable error contract.** Every refusal is `RATE_LIMITED` / HTTP 429
 *    with the tier name, so clients and dashboards can branch on it.
 */

/** Rate-limit tier names. Append-only; clients may branch on these. */
export const RATE_LIMIT_TIERS = ['auth', 'payments', 'default'] as const;

export type RateLimitTier = (typeof RATE_LIMIT_TIERS)[number];

/** Built-in ceilings used when a tier is not configured. */
export const RATE_LIMIT_TIER_DEFAULTS: Readonly<
  Record<RateLimitTier, { limit: number; windowMs: number }>
> = Object.freeze({
  // Credential endpoints: deliberately tight. A human cannot legitimately
  // retry a login more than a handful of times a minute from one host.
  auth: Object.freeze({ limit: 10, windowMs: 60_000 }),
  // Money movement: stricter than general API traffic.
  payments: Object.freeze({ limit: 60, windowMs: 60_000 }),
  // Everything else: the tenant-configured per-key budget.
  default: Object.freeze({ limit: 600, windowMs: 60_000 }),
});

/**
 * Hard ceiling on the `default` tier's own limit.
 *
 * `DEFAULT_RATE_LIMIT_MAX` may tighten or relax the default tier within this
 * bound, but never past it. Without a ceiling, setting
 * `DEFAULT_RATE_LIMIT_MAX=1000000` would disable rate limiting across the
 * whole API — and, because every strict tier is clamped to this number, it
 * would silently un-cap the money path too. Raising the ceiling is a
 * deliberate act with a capacity review behind it.
 */
export const MAX_DEFAULT_RATE_LIMIT_RPM = 10_000;

/** Stable error code returned when any tier refuses a request. */
export const RATE_LIMITED_ERROR_CODE = 'RATE_LIMITED';

/** A resolved limit for one tier. */
export interface RateLimitPolicy {
  tier: RateLimitTier;
  /** Requests permitted per window. Always `>= 1`. */
  limit: number;
  /** Window length in ms. Always `>= 1`. */
  windowMs: number;
  /** Whether the tier is keyed by client IP rather than API key. */
  keyedByIp: boolean;
}

/**
 * Strictly positive integer parse. A malformed, zero, or negative value
 * resolves to `undefined` so the caller falls back to the tier default — a
 * config typo must never silently disable a limit.
 */
function readPositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

/**
 * Env vars holding a tier's request ceiling, keyed by tier.
 *
 * The `default` tier has its **own** variables rather than sharing the
 * payments ones. It previously reused `PAYMENT_RATE_LIMIT_*`, which meant a
 * single value silently set the ceiling for the entire API: raising
 * `PAYMENT_RATE_LIMIT_MAX=100000` to loosen the money path also raised the
 * `default` tier to 100000 (and the clamp below is only applied to *strict*
 * tiers), leaving every other route effectively unthrottled. Tiers now read
 * only their own keys, so a payments override cannot widen anything else.
 */
const TIER_MAX_ENV: Readonly<Record<RateLimitTier, string>> = Object.freeze({
  auth: 'AUTH_RATE_LIMIT_MAX',
  payments: 'PAYMENT_RATE_LIMIT_MAX',
  default: 'DEFAULT_RATE_LIMIT_MAX',
});

/** Env vars holding a tier's window length, keyed by tier. */
const TIER_WINDOW_ENV: Readonly<Record<RateLimitTier, string>> = Object.freeze({
  auth: 'AUTH_RATE_LIMIT_WINDOW_MS',
  payments: 'PAYMENT_RATE_LIMIT_WINDOW_MS',
  default: 'DEFAULT_RATE_LIMIT_WINDOW_MS',
});

/** Env var holding the request ceiling for a tier. */
function maxEnvKey(tier: RateLimitTier): string {
  return TIER_MAX_ENV[tier];
}

/** Env var holding the window length for a tier. */
function windowEnvKey(tier: RateLimitTier): string {
  return TIER_WINDOW_ENV[tier];
}

/**
 * Resolve the effective policy for a tier.
 *
 * Overrides come from each tier's **own** `*_RATE_LIMIT_MAX` /
 * `*_RATE_LIMIT_WINDOW_MS` pair. Overrides are clamped so a strict tier can
 * never exceed the `default` ceiling, and the `default` ceiling itself is
 * clamped so no configuration can disable limiting entirely.
 */
export function resolveRateLimitPolicy(
  tier: RateLimitTier,
  env: NodeJS.ProcessEnv = process.env,
): RateLimitPolicy {
  const fallback = RATE_LIMIT_TIER_DEFAULTS[tier];

  const limit = readPositiveInt(env, maxEnvKey(tier)) ?? fallback.limit;
  const windowMs =
    readPositiveInt(env, windowEnvKey(tier)) ?? fallback.windowMs;

  // The default tier is the ceiling every strict tier is measured against, so
  // it is resolved first and itself capped: raising `DEFAULT_RATE_LIMIT_MAX`
  // must never be able to express "unlimited", or the clamp below would
  // propagate that to the money path.
  if (tier === 'default') {
    return {
      tier,
      limit: Math.min(limit, MAX_DEFAULT_RATE_LIMIT_RPM),
      windowMs,
      keyedByIp: false,
    };
  }

  // Stricter tiers may only tighten (invariant 2).
  return {
    tier,
    limit: Math.min(limit, resolveDefaultCeiling(env)),
    windowMs,
    keyedByIp: tier === 'auth',
  };
}

/**
 * The effective `default`-tier ceiling, used to clamp every strict tier.
 *
 * Resolved through {@link resolveRateLimitPolicy} so there is exactly one
 * definition of the ceiling — a strict tier can never be compared against a
 * different number than the tier that actually enforces it.
 */
function resolveDefaultCeiling(env: NodeJS.ProcessEnv): number {
  return resolveRateLimitPolicy('default', env).limit;
}

/** Paths that are credential-bearing and therefore IP-keyed. */
const AUTH_PATH_PATTERNS: readonly RegExp[] = [
  /^\/(?:v1\/)?auth\/(?:login|register|verify|refresh|challenge)\/?$/,
  /^\/(?:v1\/)?auth\/authenticate\/?$/,
];

/** Paths that move money and therefore draw on the stricter payments tier. */
const PAYMENT_PATH_PATTERNS: readonly RegExp[] = [
  /^\/(?:v1\/)?payments(?:\/|$)/,
  /^\/(?:v1\/)?transactions(?:\/|$)/,
];

/**
 * Classify a request path into a rate-limit tier.
 *
 * An unrecognised path lands in `default`, which is still rate limited, so
 * adding a route never leaves it unthrottled. Query strings and trailing
 * slashes are normalized before matching so `/v1/payments/` and
 * `/v1/payments?x=1` classify identically.
 */
export function resolveRateLimitTier(path: string): RateLimitTier {
  const [withoutQuery] = (path ?? '').split('?');
  let normalized = (withoutQuery || '').toLowerCase();
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  if (AUTH_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'auth';
  }
  if (PAYMENT_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'payments';
  }
  return 'default';
}

/** Ops-safe snapshot of the resolved policies for logs/metrics. No secrets. */
export function rateLimitPolicySnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | number | boolean> {
  const snapshot: Record<string, string | number | boolean> = {};
  for (const tier of RATE_LIMIT_TIERS) {
    const policy = resolveRateLimitPolicy(tier, env);
    snapshot[`rateLimitTier_${tier}_limit`] = policy.limit;
    snapshot[`rateLimitTier_${tier}_windowMs`] = policy.windowMs;
    snapshot[`rateLimitTier_${tier}_keyedByIp`] = policy.keyedByIp;
  }
  return snapshot;
}
