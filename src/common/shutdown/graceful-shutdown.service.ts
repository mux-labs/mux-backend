import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';

/**
 * Graceful-shutdown drain coordinator (#950).
 *
 * On `SIGTERM`/`SIGINT` the process must stop accepting *new* money-path
 * writes, let the writes already in flight reach a terminal state, and only
 * then close the database and exit. Killing the process mid-write is what
 * produces the worst outcome: a payment accepted by the API but never
 * confirmed, or an on-chain spend without a persisted record.
 *
 * Invariants:
 *
 * 1. **Fail-closed on writes during drain.** Once `isDraining()` is true the
 *    drain interceptor rejects every mutating request with `503
 *    SHUTDOWN_IN_PROGRESS`, so no new money-path work is admitted while the
 *    process is going away. Reads and health/readiness stay available so load
 *    balancers can observe the drain and stop routing.
 * 2. **In-flight work wins.** Started operations are tracked and given up to
 *    `GRACEFUL_SHUTDOWN_TIMEOUT_MS` to finish. Nothing is abandoned silently;
 *    if the budget expires the remaining count is logged so operators know the
 *    drain was not clean.
 * 3. **Bounded.** The drain never waits forever; after the timeout the process
 *    exits anyway and the orchestrator escalates with `SIGKILL` past its own
 *    `terminationGracePeriodSeconds`.
 * 4. **No secrets.** Only operation labels, counts and timings are logged.
 *
 * Wrap a money-path critical section with {@link trackOperation}:
 *
 * ```ts
 * const release = this.shutdown.trackOperation('payment.submit');
 * try { ... } finally { release(); }
 * ```
 */
export const GRACEFUL_SHUTDOWN_ENV = {
  TIMEOUT_MS: 'GRACEFUL_SHUTDOWN_TIMEOUT_MS',
  DRAIN_ENABLED: 'GRACEFUL_SHUTDOWN_DRAIN_ENABLED',
} as const;

/**
 * Default drain budget. Deliberately shorter than the usual container
 * `terminationGracePeriodSeconds` (30s) so the app exits on its own terms
 * before the orchestrator escalates to `SIGKILL`.
 */
export const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 25_000;

/** Hard ceiling on the drain budget, independent of the env var. */
export const MAX_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 300_000;

/** Outcome of a drain attempt, safe to log and emit as metrics. */
export interface DrainResult {
  /** `true` when every tracked operation completed inside the budget. */
  drained: boolean;
  /** Operations still in flight when the drain ended. */
  remaining: number;
  /** Wall-clock time spent waiting, in milliseconds. */
  waitedMs: number;
}

/**
 * Parse a non-negative integer env var, clamped to `max`; malformed values fall
 * back to the default so a typo cannot disable the drain or make it unbounded.
 */
function parseTimeout(
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

/** Fail-closed gate: only the exact strings `true`/`1` enable the drain. */
function parseEnabled(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

@Injectable()
export class GracefulShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdownService.name);

  /** Set as soon as a shutdown signal is observed. */
  private draining = false;

  /** Number of tracked money-path operations currently running. */
  private inFlight = 0;

  /** Resolvers waiting for the in-flight count to reach zero. */
  private readonly idleWaiters: Array<() => void> = [];

  /** Whether new writes are refused while draining. Default ON (fail-safe). */
  isDrainEnabled(): boolean {
    const raw = process.env[GRACEFUL_SHUTDOWN_ENV.DRAIN_ENABLED];
    // Absent means "enabled": refusing new work during shutdown is the safe
    // default. An operator must explicitly set it to `false` to opt out.
    return raw === undefined ? true : parseEnabled(raw);
  }

  /** Resolved drain budget in milliseconds. */
  drainTimeoutMs(): number {
    return parseTimeout(
      process.env[GRACEFUL_SHUTDOWN_ENV.TIMEOUT_MS],
      DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      MAX_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    );
  }

  /** `true` once a shutdown signal has been observed. */
  isDraining(): boolean {
    return this.draining;
  }

  /** Count of tracked operations currently in flight. */
  inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Mark the process as draining *before* awaiting in-flight work, so no new
   * write can be admitted between the signal and the drain completing.
   */
  markDraining(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    this.logger.log(
      `shutdown draining started inFlight=${this.inFlight} budgetMs=${this.drainTimeoutMs()}`,
    );
  }

  /**
   * Begin a tracked money-path operation.
   *
   * @returns An idempotent `release` function that MUST be called in a
   *   `finally` block. Calling it more than once is safe.
   */
  trackOperation(label: string): () => void {
    this.inFlight += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlight -= 1;
      if (this.inFlight <= 0) {
        this.inFlight = 0;
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) {
          resolve();
        }
      }
      void label;
    };
  }

  /**
   * Wait for in-flight operations to finish, up to `timeoutMs` (defaults to the
   * configured budget). Never throws and never waits forever.
   */
  async drain(timeoutMs: number = this.drainTimeoutMs()): Promise<DrainResult> {
    const startedAt = Date.now();

    if (this.inFlight <= 0) {
      return { drained: true, remaining: 0, waitedMs: 0 };
    }

    const drained = await this.waitForIdle(timeoutMs);
    const result: DrainResult = {
      drained,
      remaining: this.inFlight,
      waitedMs: Date.now() - startedAt,
    };

    if (drained) {
      this.logger.log(`shutdown drain complete waitedMs=${result.waitedMs}`);
    } else {
      this.logger.error(
        `shutdown drain timed out waitedMs=${result.waitedMs} remaining=${result.remaining}`,
      );
    }

    return result;
  }

  /**
   * Nest lifecycle hook. Runs before the HTTP server stops accepting
   * connections, which is exactly when new writes must start being refused.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.isDrainEnabled()) {
      this.logger.warn(
        `shutdown drain disabled via ${GRACEFUL_SHUTDOWN_ENV.DRAIN_ENABLED}; in-flight work may be abandoned`,
      );
      return;
    }
    this.logger.log(`shutdown signal received signal=${signal ?? 'unknown'}`);
    this.markDraining();
    await this.drain();
  }

  /** Nest lifecycle hook: connections are about to close. */
  onApplicationShutdown(): void {
    if (this.inFlight > 0) {
      this.logger.warn(
        `shutdown closing with inFlight=${this.inFlight} (drain budget exhausted)`,
      );
    }
  }

  /** Resolve when the in-flight count hits zero, or `false` on timeout. */
  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight <= 0) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };

      const timer = setTimeout(
        () => {
          // Drop the waiter so a later release cannot resolve a settled promise.
          const index = this.idleWaiters.indexOf(onIdle);
          if (index >= 0) {
            this.idleWaiters.splice(index, 1);
          }
          resolve(false);
        },
        Math.max(0, timeoutMs),
      );

      this.idleWaiters.push(onIdle);
    });
  }
}
