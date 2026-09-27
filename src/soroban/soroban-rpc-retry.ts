/**
 * Soroban RPC retry policy (issue #953).
 *
 * Design notes:
 *
 * The orchestrator is fail-closed: any RPC error refuses the invoke with
 * `SOROBAN_RPC_UNAVAILABLE` and nothing is submitted unsimulated. That is the
 * right default, but it is brittle. A single dropped connection, a `429` from an
 * overloaded RPC, or a `5xx` during a ledger close is indistinguishable from a
 * real outage, so a blip fails a request that would have succeeded 200ms later.
 *
 * The retry policy exists to distinguish **transient** failures (the same call
 * would plausibly succeed shortly) from **permanent** ones (the answer will not
 * change). It is deliberately conservative; the invariants below are why it is
 * safe on a money path.
 *
 * Invariants:
 *
 * 1. **Read-only operations are retried; submissions are not, by default.**
 *    `simulate` is a pure read and is retried. `submit` mutates chain state, and
 *    a transport error is ambiguous: the transaction may have landed even though
 *    the response was lost. Retrying it by default would risk a duplicate
 *    submission, so it is opt-in via `SOROBAN_RPC_RETRY_SUBMIT` and defaults to
 *    off. This is the single most important property here.
 * 2. **Only transient failures are retried.** A 4xx other than 429, a malformed
 *    request, or a simulation revert is permanent: retrying it wastes RPC
 *    capacity and delays the client's real error. See {@link isTransientRpcError}.
 * 3. **Bounded attempts and a bounded total delay.** Both are capped
 *    independently, so neither a misconfigured attempt count nor a large backoff
 *    can turn one request into an unbounded amount of RPC load.
 * 4. **Exponential backoff with full jitter.** Full jitter (a uniform draw from
 *    `[0, delay]`) rather than fixed delay, so a fleet of clients recovering from
 *    one RPC blip does not resynchronize into a thundering herd.
 * 5. **Abort signal is respected.** A client that disconnects mid-retry stops the
 *    work instead of continuing to hammer the RPC on its behalf.
 * 6. **No secret leakage.** Classification uses status codes and error names
 *    only; error messages are never propagated into logs.
 */

/** Stable error codes for the retry policy. */
export const SorobanRpcRetryErrorCode = {
  /** The RPC is unavailable and the retry budget was exhausted. */
  EXHAUSTED: 'SOROBAN_RPC_RETRY_EXHAUSTED',
  /** The call was aborted (client disconnected) before it could complete. */
  ABORTED: 'SOROBAN_RPC_RETRY_ABORTED',
} as const;

export type SorobanRpcRetryErrorCode =
  (typeof SorobanRpcRetryErrorCode)[keyof typeof SorobanRpcRetryErrorCode];

/** Default attempts, including the first (non-retry) call. */
export const DEFAULT_RPC_MAX_ATTEMPTS = 3;

/** Default base backoff, in ms. Attempt N waits ~ base * 2^(N-1) before jitter. */
export const DEFAULT_RPC_BACKOFF_MS = 200;

/** Default per-request RPC deadline, in ms. Caps the total retry delay. */
export const DEFAULT_RPC_DEADLINE_MS = 5_000;

/** Upper bound on attempts, so a misconfiguration cannot create a retry storm. */
export const MAX_RPC_ATTEMPTS = 10;

/** Upper bound on the backoff ceiling, in ms. */
export const MAX_RPC_BACKOFF_MS = 10_000;

/** Status codes that indicate a transient condition worth retrying. */
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Error names/codes that indicate a transport-level blip, not a rejection. */
const TRANSIENT_ERROR_NAMES = new Set([
  'AbortError',
  'ConnectTimeoutError',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'NetworkError',
  'RequestTimeoutError',
  'SocketError',
  'TimeoutError',
]);

/** Error names that indicate a permanent rejection. Never retried. */
const PERMANENT_ERROR_NAMES = new Set([
  'BadRequestError',
  'ContractError',
  'InvalidRequestError',
  'NotFoundError',
  'ParseError',
  'SdkError',
  'ValidationError',
]);

/** Resolved, clamped retry policy. */
export interface SorobanRpcRetryPolicy {
  /** Total attempts including the first. At least 1. */
  maxAttempts: number;
  /** Base backoff in ms for the exponential curve. */
  backoffMs: number;
  /** Total wall-clock budget for all attempts and waits, in ms. */
  deadlineMs: number;
  /**
   * Whether a mutating `submit` may be retried.
   *
   * Defaults to false: a lost submit response is ambiguous and a blind retry can
   * duplicate a transaction on chain.
   */
  retrySubmit: boolean;
}

const toInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed)
    ? parsed
    : fallback;
};

const parseBoolean = (
  value: string | undefined,
  fallback: boolean,
): boolean => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

/**
 * Resolves the retry policy from the environment, clamping every value.
 *
 * Clamping rather than rejecting is deliberate: a typo in an integer variable
 * should not take down a deployment that would otherwise be fine, and every
 * bound here is a safety ceiling rather than a correctness requirement.
 */
export function resolveSorobanRpcRetryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): SorobanRpcRetryPolicy {
  return {
    maxAttempts: Math.min(
      Math.max(
        toInt(env.SOROBAN_RPC_MAX_ATTEMPTS, DEFAULT_RPC_MAX_ATTEMPTS),
        1,
      ),
      MAX_RPC_ATTEMPTS,
    ),
    backoffMs: Math.min(
      Math.max(
        toInt(env.SOROBAN_RPC_RETRY_BACKOFF_MS, DEFAULT_RPC_BACKOFF_MS),
        0,
      ),
      MAX_RPC_BACKOFF_MS,
    ),
    deadlineMs: Math.max(
      toInt(env.SOROBAN_RPC_DEADLINE_MS, DEFAULT_RPC_DEADLINE_MS),
      0,
    ),
    // Deny-by-default: a mutating call is not retried unless an operator opts in.
    retrySubmit: parseBoolean(env.SOROBAN_RPC_RETRY_SUBMIT, false),
  };
}

/**
 * Extracts an HTTP-ish status code from an arbitrary error, if it has one.
 *
 * Checks several shapes because RPC clients disagree: `statusCode`, `status`,
 * `response.status`, and `code` (when numeric, e.g. an HTTP-ish code surfaced on
 * a generic error object).
 */
export function statusCodeOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const candidate = err as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    code?: unknown;
  };
  for (const value of [
    candidate.statusCode,
    candidate.status,
    candidate.response?.status,
    candidate.code,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** Whether an error represents an abort/cancellation. */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.code === 'ABORT_ERR' ||
    candidate.code === 20
  );
}

/**
 * Whether an error is transient and therefore worth retrying.
 *
 * Fails closed in the sense that matters: anything not positively identified as
 * transient is treated as permanent. An unrecognized error is usually a bug in
 * the RPC client, and retrying an unknown failure blindly is how a retry storm
 * starts.
 */
export function isTransientRpcError(err: unknown): boolean {
  // An explicit abort is never transient: the caller is gone or cancelled.
  if (isAbortError(err)) {
    return false;
  }

  const status = statusCodeOf(err);
  if (status !== undefined) {
    return TRANSIENT_STATUS_CODES.has(status);
  }

  const name = err instanceof Error ? err.name : undefined;
  if (name && PERMANENT_ERROR_NAMES.has(name)) {
    return false;
  }
  if (name && TRANSIENT_ERROR_NAMES.has(name)) {
    return true;
  }

  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_ERROR_NAMES.has(code);
}

/**
 * Computes the delay before the next attempt, using full jitter.
 *
 * `attempt` is 1-based (the number of attempts already made). The exponential
 * term is capped so a long chain cannot produce an unbounded delay; the caller
 * additionally clamps against the remaining deadline.
 */
export function backoffDelayMs(
  attempt: number,
  policy: SorobanRpcRetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.backoffMs * 2 ** Math.max(attempt - 1, 0);
  const capped = Math.min(exponential, MAX_RPC_BACKOFF_MS);
  // Full jitter: uniform in [0, capped]. Spreading retries out is what stops a
  // fleet from resynchronizing into a thundering herd after one blip.
  return Math.floor(random() * capped);
}

/** Why a retry loop stopped. */
export type SorobanRpcRetryOutcome = 'success' | 'exhausted' | 'aborted';

/** Result of {@link withSorobanRpcRetry}. */
export interface SorobanRpcRetryResult<T> {
  outcome: SorobanRpcRetryOutcome;
  /** Number of attempts actually made, including the first. */
  attempts: number;
  /** The successful value. Only present when `outcome === 'success'`. */
  value?: T;
  /**
   * The last error, for the caller to classify. Only present when the outcome is
   * not `success`.
   */
  error?: unknown;
}

/** Per-call knobs. */
export interface SorobanRpcRetryOptions {
  policy: SorobanRpcRetryPolicy;
  /**
   * Whether this call is safe to retry. `simulate` is a pure read; `submit`
   * mutates chain state and is only retryable when `policy.retrySubmit` is set.
   */
  retryable: boolean;
  /** Stable label used in metrics/logs. Never user input. */
  operation: 'simulate' | 'submit';
  /** Aborts the retry loop when the caller goes away. */
  signal?: AbortSignal;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable jitter source, for deterministic tests. */
  random?: () => number;
  /** Observability hook. Receives only labels, never arguments or keys. */
  onRetry?: (info: {
    operation: string;
    attempt: number;
    delayMs: number;
  }) => void;
}

const abortError = (): Error => {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Runs `fn` under the retry policy.
 *
 * Never throws for an RPC failure: it returns the outcome and the last error so
 * the caller decides the stable error code. That keeps the retry concern out of
 * the orchestration rules — the caller still decides that a failed invoke is
 * refused, it just no longer fails on the first transient blip.
 */
export async function withSorobanRpcRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: SorobanRpcRetryOptions,
): Promise<SorobanRpcRetryResult<T>> {
  const { policy, retryable, operation, signal } = options;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const startedAt = now();

  // A non-retryable call still gets exactly one attempt.
  const maxAttempts = retryable ? policy.maxAttempts : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      return { outcome: 'aborted', attempts: attempt - 1, error: abortError() };
    }

    try {
      const value = await fn(attempt);
      return { outcome: 'success', attempts: attempt, value };
    } catch (err) {
      lastError = err;

      if (isAbortError(err) || signal?.aborted) {
        return { outcome: 'aborted', attempts: attempt, error: err };
      }

      const attemptsLeft = maxAttempts - attempt;
      if (attemptsLeft <= 0 || !isTransientRpcError(err)) {
        return { outcome: 'exhausted', attempts: attempt, error: err };
      }

      const delay = backoffDelayMs(attempt, policy, random);
      const elapsed = now() - startedAt;
      if (policy.deadlineMs > 0 && elapsed + delay >= policy.deadlineMs) {
        // The next attempt would land outside the caller's budget. Stop rather
        // than convert a fast failure into a slow one.
        return { outcome: 'exhausted', attempts: attempt, error: err };
      }

      options.onRetry?.({ operation, attempt, delayMs: delay });
      try {
        await sleep(delay, signal);
      } catch (sleepErr) {
        return { outcome: 'aborted', attempts: attempt, error: sleepErr };
      }
    }
  }

  return { outcome: 'exhausted', attempts: maxAttempts, error: lastError };
}
