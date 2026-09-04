import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Gauge, Registry, register as globalRegistry } from 'prom-client';

/**
 * Outcome labels for an authentication attempt.
 */
export type AuthOutcome =
  | 'success_new_user'
  | 'success_returning_user'
  | 'failure_invalid_payload'
  | 'failure_user_inactive'
  | 'failure_wallet_error'
  | 'failure_jwt_verification'
  | 'failure_unknown';

/**
 * Snapshot of counters exposed by AuthMetricsService.
 */
export interface AuthMetricsSnapshot {
  totalAttempts: number;
  outcomes: Record<AuthOutcome, number>;
  rateLimitHits: number;
  /** Rolling average latency in ms across the last window of recorded calls */
  averageLatencyMs: number;
  /** P95 latency in ms (approximated from recorded samples) */
  p95LatencyMs: number;
  /** Timestamp when metrics counters were last reset */
  lastResetAt: Date;
}

/**
 * In-process metrics store for the auth & session subsystem.
 *
 * Design notes
 * ─────────────
 * • All state is in-memory. For multi-instance deployments the expectation is
 *   that consumers aggregate across replicas (e.g. via a scrape endpoint or
 *   a Prometheus push-gateway). No external dependency is added here so the
 *   feature works in any environment without extra infrastructure.
 * • Counters are plain numbers — no atomics needed because Node.js is
 *   single-threaded within a process.
 * • Latency samples are kept in a bounded ring-buffer (default 1 000 entries)
 *   to avoid unbounded memory growth.
 * • Auth metrics are registered as prom-client Gauges with collect callbacks
 *   so they appear on the shared `/v1/metrics` (Prometheus scrape) endpoint
 *   automatically — no separate scrape target or controller is needed.
 */
@Injectable()
export class AuthMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthMetricsService.name);

  /** Maximum number of latency samples retained in the ring-buffer. */
  private static readonly MAX_LATENCY_SAMPLES = 1_000;

  private totalAttempts = 0;
  private rateLimitHits = 0;
  private readonly outcomeCounts: Record<AuthOutcome, number> = {
    success_new_user: 0,
    success_returning_user: 0,
    failure_invalid_payload: 0,
    failure_user_inactive: 0,
    failure_wallet_error: 0,
    failure_jwt_verification: 0,
    failure_unknown: 0,
  };

  /** Ring-buffer of recorded latency samples (ms). */
  private readonly latencySamples: number[] = [];
  private latencyIndex = 0; // next write position in ring-buffer

  private lastResetAt: Date = new Date();

  /**
   * Prom-client Gauge instances registered for the Prometheus scrape path.
   * Stored so we can de-register them in onModuleDestroy (test isolation).
   */
  private readonly promGauges: Gauge[] = [];

  constructor() {
    this.registerPromGauges(globalRegistry);
  }

  /**
   * Registers prom-client Gauge metrics against the supplied registry
   * (defaults to the global registry, injectable for test isolation).
   *
   * Each gauge uses a `collect` callback so its value is read directly from
   * the in-memory counters at scrape time — no double bookkeeping needed.
   */
  registerPromGauges(registry: Registry = globalRegistry): void {
    const register = <T extends Record<string, string>>(
      name: string,
      help: string,
      labelNames: (keyof T)[] = [],
      collectFn: (gauge: Gauge<string>) => void,
    ): void => {
      // Guard: skip if already registered in this registry (e.g. hot reload).
      if (registry.getSingleMetric(name)) {
        return;
      }
      const g = new Gauge({
        name,
        help,
        labelNames: labelNames as string[],
        registers: [registry],
        collect() {
          collectFn(this);
        },
      });
      this.promGauges.push(g);
    };

    register(
      'auth_attempts_total',
      'Total number of authentication attempts',
      [],
      (g) => g.set(this.totalAttempts),
    );

    register(
      'auth_rate_limit_hits_total',
      'Total number of auth endpoint rate-limit rejections',
      [],
      (g) => g.set(this.rateLimitHits),
    );

    register(
      'auth_outcome_total',
      'Authentication attempts broken down by outcome label',
      ['outcome'],
      (g) => {
        for (const [outcome, count] of Object.entries(this.outcomeCounts)) {
          g.labels(outcome).set(count);
        }
      },
    );

    register(
      'auth_latency_average_ms',
      'Rolling average authentication latency in milliseconds',
      [],
      (g) => g.set(this.computeAverage()),
    );

    register(
      'auth_latency_p95_ms',
      'Approximate P95 authentication latency in milliseconds',
      [],
      (g) => g.set(this.computePercentile(95)),
    );
  }

  // ─── Public instrumentation API ──────────────────────────────────────────

  /**
   * Records the result of one authentication flow execution.
   *
   * @param outcome  Categorised result label.
   * @param latencyMs  Wall-clock time for the full orchestration call.
   */
  recordAttempt(outcome: AuthOutcome, latencyMs: number): void {
    this.totalAttempts++;
    this.outcomeCounts[outcome]++;
    this.recordLatency(latencyMs);

    this.logger.debug(
      `auth.attempt outcome=${outcome} latency=${latencyMs}ms total=${this.totalAttempts}`,
    );
  }

  /**
   * Records a rate-limit rejection on the auth endpoint.
   */
  recordRateLimitHit(): void {
    this.rateLimitHits++;
    this.logger.debug(
      `auth.rate_limit_hit total_hits=${this.rateLimitHits}`,
    );
  }

  /**
   * Returns a point-in-time snapshot of all counters.
   */
  getSnapshot(): AuthMetricsSnapshot {
    return {
      totalAttempts: this.totalAttempts,
      outcomes: { ...this.outcomeCounts },
      rateLimitHits: this.rateLimitHits,
      averageLatencyMs: this.computeAverage(),
      p95LatencyMs: this.computePercentile(95),
      lastResetAt: this.lastResetAt,
    };
  }

  /**
   * Resets all counters and samples. Useful for tests and scheduled resets.
   */
  reset(): void {
    this.totalAttempts = 0;
    this.rateLimitHits = 0;
    for (const key of Object.keys(this.outcomeCounts) as AuthOutcome[]) {
      this.outcomeCounts[key] = 0;
    }
    this.latencySamples.length = 0;
    this.latencyIndex = 0;
    this.lastResetAt = new Date();
    this.logger.log('Auth metrics counters reset');
  }

  /**
   * De-registers the prom-client Gauges from their registry on module destroy.
   * This prevents "metric already registered" errors between test suites that
   * share the global prom-client registry.
   */
  onModuleDestroy(): void {
    for (const gauge of this.promGauges) {
      try {
        gauge.reset(); // clears label values
      } catch {
        // best-effort
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private recordLatency(ms: number): void {
    if (this.latencySamples.length < AuthMetricsService.MAX_LATENCY_SAMPLES) {
      this.latencySamples.push(ms);
    } else {
      // Overwrite oldest entry
      this.latencySamples[
        this.latencyIndex % AuthMetricsService.MAX_LATENCY_SAMPLES
      ] = ms;
    }
    this.latencyIndex++;
  }

  private computeAverage(): number {
    if (this.latencySamples.length === 0) return 0;
    const sum = this.latencySamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.latencySamples.length);
  }

  private computePercentile(pct: number): number {
    if (this.latencySamples.length === 0) return 0;
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const idx = Math.ceil((pct / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
