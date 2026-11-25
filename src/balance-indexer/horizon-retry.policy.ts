/**
 * Horizon read retry policy (#952).
 *
 * Horizon is an external dependency that intermittently returns 429/5xx or
 * drops connections. Retrying those failures *once, locally, inside the read*
 * keeps the balance index fresh without pushing retry storms up into callers.
 *
 * Invariants (fail-closed):
 *
 * 1. **Only idempotent reads are retried.** The policy wraps a `GET`-style
 *    operation. Writes (`upsert`/`create`/`update`) are never executed by this
 *    helper, so a retry can never double-apply a balance mutation.
 * 2. **Only transient failures are retried.** 408/429/5xx and transport-level
 *    errors (connection reset/timeout/DNS) are retried; other 4xx such as
 *    400/403/404 are permanent and surface immediately. Retrying a 404 for a
 *    closed account would only amplify load.
 * 3. **Bounded.** Attempts default to {@link DEFAULT_HORIZON_MAX_RETRIES} and
 *    are clamped to {@link MAX_HORIZON_RETRIES}; the schedule is exponential
 *    with bounded jitter so many concurrent readers do not synchronise into a
 *    thundering herd on a recovering Horizon.
 * 4. **Never partial.** When the budget is exhausted the helper throws
 *    {@link HorizonRetryExhaustedError} rather than resolving with a default or
 *    empty value, because the caller treats a resolved snapshot as authoritative
 *    and would otherwise persist `0` over real balances.
 * 5. **No secrets in logs/metrics.** Only attempt counts, HTTP status codes and
 *    error class names are emitted — never request headers or response bodies.
 */

/** Environment variables that tune the Horizon retry budget. */
export const HORIZON_RETRY_ENV = {
  MAX_RETRIES: 'STELLAR_HORIZON_MAX_RETRIES',
  BACKOFF_MS: 'STELLAR_HORIZON_RETRY_BACKOFF_MS',
  JITTER_MS: 'STELLAR_HORIZON_RETRY_JITTER_MS',
  BUDGET_MS: 'STELLAR_HORIZON_RETRY_BUDGET_MS',
} as const;

export const DEFAULT_HORIZON_MAX_RETRIES = 3;
export const DEFAULT_HORIZON_RETRY_BACKOFF_MS = 500;
export const DEFAULT_HORIZON_RETRY_JITTER_MS = 250;
/**
 * Hard ceiling on a wall-clock retry budget. Even with a pathological env
 * config a single Horizon read can never pin a request open indefinitely.
 */
export const DEFAULT_HORIZON_RETRY_BUDGET_MS = 15_000;
/** Hard ceiling on configured retries, independent of the env var. */
export const MAX_HORIZON_RETRIES = 10;

/** Resolved, validated retry budget for one Horizon client instance. */
export interface HorizonRetryConfig {
  /** Number of retries *after* the initial attempt. */
  maxRetries: number;
  /** Base delay for exponential backoff, in milliseconds. */
  backoffMs: number;
  /** Maximum random jitter added to each delay, in milliseconds. */
  jitterMs: number;
  /** Upper bound on the total time spent retrying one read, in milliseconds. */
  budgetMs: number;
}

/** Injectable sleep, so unit tests never wait on a real clock. */
export interface HorizonSleepFn {
  (ms: number): Promise<void>;
}

/**
 * Injectable random source, so unit tests can pass a deterministic generator
 * (e.g. `() => 0`) instead of relying on `Math.random`. Defaults to
 * `Math.random` in production.
 */
export interface HorizonRandomFn {
  (): number;
}

const realSleep: HorizonSleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a non-negative integer env var. Anything unset, non-numeric or negative
 * resolves to the provided default — a typo must not silently disable retries
 * or create an unbounded loop. Values above `max` are clamped.
 */
function parseIntEnv(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

/**
 * Resolve the retry budget from the environment.
 *
 * Fail-closed by omission: a missing or malformed value leaves the documented
 * default in place rather than resolving to "retry forever".
 */
export function resolveHorizonRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): HorizonRetryConfig {
  return {
    maxRetries: parseIntEnv(
      env[HORIZON_RETRY_ENV.MAX_RETRIES],
      DEFAULT_HORIZON_MAX_RETRIES,
      MAX_HORIZON_RETRIES,
    ),
    backoffMs: parseIntEnv(
      env[HORIZON_RETRY_ENV.BACKOFF_MS],
      DEFAULT_HORIZON_RETRY_BACKOFF_MS,
      Number.MAX_SAFE_INTEGER,
    ),
    jitterMs: parseIntEnv(
      env[HORIZON_RETRY_ENV.JITTER_MS],
      DEFAULT_HORIZON_RETRY_JITTER_MS,
      Number.MAX_SAFE_INTEGER,
    ),
    budgetMs: parseIntEnv(
      env[HORIZON_RETRY_ENV.BUDGET_MS],
      DEFAULT_HORIZON_RETRY_BUDGET_MS,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

/**
 * HTTP statuses that indicate a transient Horizon failure.
 *
 * 408 (request timeout), 429 (rate limited) and 5xx are the only statuses a
 * retry can plausibly fix. Every other 4xx is a caller/config problem.
 */
export function isRetryableHorizonStatus(status: number): boolean {
  if (!Number.isFinite(status)) {
    return false;
  }
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Transport-level error codes that are safe to retry on an idempotent read. */
export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_NETWORK',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** True when an error carries a retryable Node/axios transport code. */
function hasRetryableNetworkCode(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code);
}

/** True when an axios error was raised without a response (connection-level). */
function isTransportFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { isAxiosError?: unknown; response?: unknown };
  return candidate.isAxiosError === true && candidate.response === undefined;
}

/**
 * Extract the HTTP status from an axios-style error (`response.status`) or a
 * {@link HorizonRequestError}-style error (`statusCode`), when present.
 */
export function horizonErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const candidate = err as {
    response?: { status?: unknown };
    statusCode?: unknown;
  };
  const status = candidate.response?.status ?? candidate.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Classify an error as transient (retry) or permanent (surface immediately).
 *
 * Deliberately conservative: anything that is not demonstrably transient is
 * treated as permanent so an unexpected error shape cannot trigger a retry
 * storm against Horizon.
 */
export function isRetryableHorizonError(err: unknown): boolean {
  const status = horizonErrorStatus(err);
  if (status !== undefined) {
    return isRetryableHorizonStatus(status);
  }
  return isTransportFailure(err) || hasRetryableNetworkCode(err);
}

/**
 * Honour a Horizon `Retry-After` header when the server sends one (in seconds
 * or as an HTTP date). Returns `undefined` when absent or unparseable so the
 * caller falls back to the exponential schedule.
 */
export function parseRetryAfterMs(
  value: unknown,
  now: number = Date.now(),
): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value * 1000;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - now);
  }
  return undefined;
}

/** Extract a `R