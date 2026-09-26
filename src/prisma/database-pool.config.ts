/**
 * PostgreSQL connection-pool sizing for the Prisma client (#951).
 *
 * Background: the pool is a hard ceiling on concurrent DB work. Left
 * unconfigured it is derived from the container's *host* CPU count
 * (`cpus * 2 + 1`), which is wrong in two common cases:
 *
 *  - A CPU-limited container on a many-core host opens far more connections
 *    than it can use, and N replicas multiply that against a single Postgres
 *    `max_connections` budget until connections are refused.
 *  - A very small pool queues requests behind slow queries and turns a slow
 *    dependency into request timeouts.
 *
 * This module turns pool sizing into an explicit, validated, per-deployment
 * decision (see docs/DB-POOL-SIZING.md) while staying opt-in: when nothing is
 * configured the URL is passed through untouched, so existing deployments are
 * unaffected.
 *
 * Invariants:
 * 1. **Opt-in.** Only explicitly configured values are appended to the URL.
 * 2. **Explicit URL wins.** A parameter already present in `DATABASE_URL` is
 *    never overwritten, so an operator can override per-environment.
 * 3. **Fail-closed on nonsense.** A non-numeric or out-of-range value is a
 *    startup error, not a silent fallback to an unbounded pool.
 * 4. **No secrets.** Only counts and seconds are logged; the URL (which carries
 *    credentials) is never logged.
 */

/** Environment variables that size the Prisma/Postgres pool. */
export const DATABASE_POOL_ENV = {
  POOL_SIZE: 'DATABASE_POOL_SIZE',
  POOL_TIMEOUT_SECONDS: 'DATABASE_POOL_TIMEOUT_SECONDS',
  CONNECT_TIMEOUT_SECONDS: 'DATABASE_CONNECT_TIMEOUT_SECONDS',
} as const;

/** Hard ceiling so a typo cannot exhaust Postgres `max_connections`. */
export const MAX_DATABASE_POOL_SIZE = 100;
/** Upper bound on any pool/connect timeout, in seconds. */
export const MAX_DATABASE_POOL_TIMEOUT_SECONDS = 300;

/** Resolved, validated pool configuration. */
export interface DatabasePoolConfig {
  /** Prisma `connection_limit`; `undefined` leaves the engine default. */
  connectionLimit?: number;
  /** Prisma `pool_timeout` (seconds); `undefined` leaves the engine default. */
  poolTimeoutSeconds?: number;
  /** Prisma `connect_timeout` (seconds); `undefined` leaves the default. */
  connectTimeoutSeconds?: number;
}

/** A single validation failure, with the offending variable name. */
export interface DatabasePoolValidationIssue {
  variable: string;
  message: string;
}

/** Parse an optional integer, reporting malformed input instead of guessing. */
function parseOptionalInt(raw: string | undefined): {
  value?: number;
  invalid: boolean;
} {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return { invalid: false };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { invalid: true };
  }
  return { value: parsed, invalid: false };
}

/**
 * Validate the pool env vars. Returns every issue so a caller can render one
 * actionable startup error instead of failing on the first bad value.
 */
export function validateDatabasePoolEnv(
  env: NodeJS.ProcessEnv = process.env,
): DatabasePoolValidationIssue[] {
  const issues: DatabasePoolValidationIssue[] = [];

  const check = (
    variable: string,
    raw: string | undefined,
    max: number,
  ): void => {
    const parsed = parseOptionalInt(raw);
    if (
      parsed.invalid ||
      (parsed.value !== undefined && (parsed.value < 1 || parsed.value > max))
    ) {
      issues.push({
        variable,
        message: `must be an integer between 1 and ${max}`,
      });
    }
  };

  check(
    DATABASE_POOL_ENV.POOL_SIZE,
    env[DATABASE_POOL_ENV.POOL_SIZE],
    MAX_DATABASE_POOL_SIZE,
  );
  check(
    DATABASE_POOL_ENV.POOL_TIMEOUT_SECONDS,
    env[DATABASE_POOL_ENV.POOL_TIMEOUT_SECONDS],
    MAX_DATABASE_POOL_TIMEOUT_SECONDS,
  );
  check(
    DATABASE_POOL_ENV.CONNECT_TIMEOUT_SECONDS,
    env[DATABASE_POOL_ENV.CONNECT_TIMEOUT_SECONDS],
    MAX_DATABASE_POOL_TIMEOUT_SECONDS,
  );

  return issues;
}

/**
 * Resolve the pool configuration. Assumes {@link validateDatabasePoolEnv} was
 * run; out-of-range values are still clamped defensively.
 */
export function resolveDatabasePoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabasePoolConfig {
  const clamp = (value: number | undefined, max: number): number | undefined =>
    value === undefined ? undefined : Math.min(value, max);

  return {
    connectionLimit: clamp(
      parseOptionalInt(env[DATABASE_POOL_ENV.POOL_SIZE]).value,
      MAX_DATABASE_POOL_SIZE,
    ),
    poolTimeoutSeconds: clamp(
      parseOptionalInt(env[DATABASE_POOL_ENV.POOL_TIMEOUT_SECONDS]).value,
      MAX_DATABASE_POOL_TIMEOUT_SECONDS,
    ),
    connectTimeoutSeconds: clamp(
      parseOptionalInt(env[DATABASE_POOL_ENV.CONNECT_TIMEOUT_SECONDS]).value,
      MAX_DATABASE_POOL_TIMEOUT_SECONDS,
    ),
  };
}

/** `true` when at least one pool parameter was explicitly configured. */
export function hasDatabasePoolOverrides(config: DatabasePoolConfig): boolean {
  return (
    config.connectionLimit !== undefined ||
    config.poolTimeoutSeconds !== undefined ||
    config.connectTimeoutSeconds !== undefined
  );
}

/**
 * Append the configured pool parameters to a Postgres URL.
 *
 * Parameters already present on the URL are preserved (the URL is the
 * operator's explicit choice and wins). A URL that cannot be parsed is
 * returned unchanged so the connection attempt fails with the driver's own
 * (actionable) error rather than a mangled URL.
 */
export function applyDatabasePoolConfig(
  url: string,
  config: DatabasePoolConfig,
): string {
  if (!hasDatabasePoolOverrides(config) || !url) {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const setIfAbsent = (key: string, value: number | undefined): void => {
    if (value !== undefined && !parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, String(value));
    }
  };

  setIfAbsent('connection_limit', config.connectionLimit);
  setIfAbsent('pool_timeout', config.poolTimeoutSeconds);
  setIfAbsent('connect_timeout', config.connectTimeoutSeconds);

  return parsed.toString();
}

/**
 * Compute the runtime `DATABASE_URL` with pool parameters applied.
 *
 * Returns `undefined` when `DATABASE_URL` is unset so the caller keeps the
 * driver's default error path unchanged.
 */
export function buildRuntimeDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const base = env.DATABASE_URL;
  if (!base) {
    return undefined;
  }
  return applyDatabasePoolConfig(base, resolveDatabasePoolConfig(env));
}

/**
 * Secret-free snapshot of the resolved sizing, for startup logs and ops
 * dashboards. Never includes the URL, user, password, or host.
 */
export function databasePoolSnapshot(
  config: DatabasePoolConfig,
): Record<string, number | string> {
  return {
    connectionLimit: config.connectionLimit ?? 'engine-default',
    poolTimeoutSeconds: config.poolTimeoutSeconds ?? 'engine-default',
    connectTimeoutSeconds: config.connectTimeoutSeconds ?? 'engine-default',
  };
}
