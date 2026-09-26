import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Per-developer API quotas (issue #955).
 *
 * Design notes:
 *
 * The per-API-key rate limit is not a tenant boundary. A developer can hold many
 * keys across many projects, and a client that rotates keys — or simply owns
 * several — can exceed an intended aggregate limit while every individual key
 * stays comfortably under its own. The limit an operator means when they say
 * "this developer may make N requests a minute" has to be enforced at the
 * developer, summed across every key and project that developer owns.
 *
 * Invariants:
 *
 * 1. **Deny-by-default.** Quota enforcement is off unless
 *    `DEVELOPER_QUOTAS_ENABLED` is exactly `true`. A deployment that has not set
 *    it behaves exactly as before this change.
 * 2. **Keyed on the server-resolved developer**, never a client-supplied id. A
 *    body or query parameter cannot widen a quota.
 * 3. **Bounded both ways.** The limit is clamped to
 *    `[1, DEVELOPER_QUOTA_MAX_RPM]` and the tracked-window map is bounded, so a
 *    misconfiguration cannot grant an effectively unlimited quota and a flood of
 *    distinct developer ids cannot grow memory without limit.
 * 4. **Sliding window, counted per developer.** All of a developer's keys and
 *    projects share one counter, which is the whole point.
 * 5. **Fail-closed on the database.** Cleanup refuses rather than reporting a
 *    false success. The in-memory counter has no database dependency, so request
 *    admission is unaffected by a DB outage.
 * 6. **No secret leakage.** Counters, limits, and window bounds only — never a
 *    key, a developer email, or a request body.
 */

/** Stable error codes. Clients and dashboards branch on these, never prose. */
export const DeveloperQuotaErrorCode = {
  /** The developer exceeded their quota for the current window. */
  EXCEEDED: 'DEVELOPER_QUOTA_EXCEEDED',
  /** Cleanup could not reach the database. */
  CLEANUP_DEPENDENCY_UNAVAILABLE: 'DEVELOPER_QUOTA_CLEANUP_UNAVAILABLE',
  /** The configured batch size or window was invalid. */
  CLEANUP_INVALID_BATCH_SIZE: 'DEVELOPER_QUOTA_CLEANUP_INVALID_BATCH_SIZE',
} as const;

export type DeveloperQuotaErrorCode =
  (typeof DeveloperQuotaErrorCode)[keyof typeof DeveloperQuotaErrorCode];

/** Default requests per window for a developer with no explicit quota. */
export const DEFAULT_DEVELOPER_QUOTA_RPM = 600;

/** Default sliding-window length, in ms. */
export const DEFAULT_DEVELOPER_QUOTA_WINDOW_MS = 60_000;

/**
 * Upper bound on any per-developer quota.
 *
 * A hard ceiling on the *policy*: raising it is a deliberate act, so a typo
 * cannot open the API to a single tenant.
 */
export const MAX_DEVELOPER_QUOTA_RPM = 10_000;

/**
 * Maximum number of developers tracked in the in-process window map.
 *
 * Bounded so an unauthenticated flood of distinct ids cannot grow memory without
 * limit. The least-recently-seen entry is evicted at the cap, which costs that
 * developer a fresh (empty) window rather than a denial.
 */
export const MAX_TRACKED_DEVELOPERS = 10_000;

/** Default rows deleted per cleanup pass. */
export const DEFAULT_QUOTA_CLEANUP_BATCH_SIZE = 1000;

/** Upper bound on rows deleted per cleanup pass. */
export const MAX_QUOTA_CLEANUP_BATCH_SIZE = 10_000;

/** DI token for {@link RateLimitRecordStore}. */
export const RATE_LIMIT_RECORD_STORE = Symbol('RATE_LIMIT_RECORD_STORE');

/** Narrow view of the `RateLimitRecord` delete surface the service needs. */
export interface RateLimitRecordStore {
  rateLimitRecord: {
    deleteMany(args: {
      where: { windowStart: { lt: Date } };
      take?: number;
    }): Promise<{ count: number }>;
  };
}

/** Resolved, clamped quota configuration. */
export interface DeveloperQuotaConfig {
  /** Whether enforcement is active. */
  enabled: boolean;
  /** Requests allowed per window, per developer. Always >= 1. */
  limitRpm: number;
  /** Sliding-window length, in ms. Always > 0. */
  windowMs: number;
}

/** Result of one quota check. */
export interface DeveloperQuotaDecision {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Epoch ms at which the window frees up. */
  resetAt: number;
  /** The limit that was applied. */
  limitRpm: number;
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
 * The hard ceiling on any per-developer quota for this deployment.
 *
 * Lowering `DEVELOPER_QUOTA_MAX_RPM` below the default limit tightens every
 * quota at once — that is the emergency brake. It is itself clamped to
 * `MAX_DEVELOPER_QUOTA_RPM`, so the ceiling cannot be raised by configuration
 * alone.
 */
function maxQuotaRpm(env: NodeJS.ProcessEnv): number {
  return Math.min(
    Math.max(toInt(env.DEVELOPER_QUOTA_MAX_RPM, MAX_DEVELOPER_QUOTA_RPM), 1),
    MAX_DEVELOPER_QUOTA_RPM,
  );
}

/**
 * Resolves the quota configuration from the environment, clamped.
 *
 * Clamping rather than rejecting: a typo in an integer variable should not take
 * down a deployment that is otherwise fine, and every bound is a safety ceiling.
 */
export function resolveDeveloperQuotaConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeveloperQuotaConfig {
  return {
    // Deny-by-default: only an explicit truthy value turns this on.
    enabled: parseBoolean(env.DEVELOPER_QUOTAS_ENABLED, false),
    limitRpm: Math.min(
      Math.max(
        toInt(env.DEVELOPER_QUOTA_DEFAULT_RPM, DEFAULT_DEVELOPER_QUOTA_RPM),
        1,
      ),
      maxQuotaRpm(env),
    ),
    windowMs: Math.max(
      toInt(env.DEVELOPER_QUOTA_WINDOW_MS, DEFAULT_DEVELOPER_QUOTA_WINDOW_MS),
      1,
    ),
  };
}

/**
 * RateLimitService
 *
 * Owns per-developer request accounting and the cleanup of expired
 * `RateLimitRecord` rows.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  /**
   * Sliding-window counters keyed by developer id.
   *
   * `timestamps` holds the epoch ms of each counted request in the current
   * window. Entries older than the window are pruned on access, which keeps each
   * array proportional to the limit rather than to elapsed time.
   */
  private readonly windows = new Map<string, number[]>();

  constructor(
    @Inject(RATE_LIMIT_RECORD_STORE)
    private readonly store: RateLimitRecordStore,
    private readonly metrics: MetricsService,
  ) {}

  /** Whether per-developer quotas are enforced for this deployment. */
  isQuotaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return resolveDeveloperQuotaConfig(env).enabled;
  }

  /**
   * Counts one request against a developer's quota and decides whether it may
   * proceed.
   *
   * `developerId` must come from the server-resolved principal. A client-supplied
   * id here would let a caller borrow or evade another developer's quota, so the
   * quota guard is the only intended caller.
   *
   * A disabled quota admits everything, which is what makes the flag
   * deny-by-default and instantly reversible.
   */
  consume(
    developerId: string,
    env: NodeJS.ProcessEnv = process.env,
    now: number = Date.now(),
  ): DeveloperQuotaDecision {
    const config = resolveDeveloperQuotaConfig(env);

    if (!config.enabled) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        resetAt: now + config.windowMs,
        limitRpm: config.limitRpm,
      };
    }

    // A request with no resolved developer id cannot be accounted for, so it
    // cannot be admitted through a quota it might exceed. Refuse, don't guess.
    if (typeof developerId !== 'string' || developerId.length === 0) {
      this.metrics.incrementCounter('developer_quota_denied_unattributed');
      this.logger.warn(
        'developer.quota denied: request has no resolved developer id',
      );
      return {
        allowed: false,
        remaining: 0,
        resetAt: now + config.windowMs,
        limitRpm: config.limitRpm,
      };
    }

    const windowStart = now - config.windowMs;
    const timestamps = (this.windows.get(developerId) ?? []).filter(
      (at) => at > windowStart,
    );

    if (timestamps.length >= config.limitRpm) {
      this.windows.set(developerId, timestamps);
      this.metrics.incrementCounter('developer_quota_exceeded');
      this.logger.warn(
        `developer.quota exceeded limit=${config.limitRpm} ` +
          `windowMs=${config.windowMs}`,
      );
      return {
        allowed: false,
        remaining: 0,
        // The oldest counted request leaving the window is when a slot frees.
        resetAt: (timestamps[0] ?? now) + config.windowMs,
        limitRpm: config.limitRpm,
      };
    }

    timestamps.push(now);
    this.storeWindow(developerId, timestamps);

    this.metrics.incrementCounter('developer_quota_admitted');
    return {
      allowed: true,
      remaining: config.limitRpm - timestamps.length,
      resetAt: now + config.windowMs,
      limitRpm: config.limitRpm,
    };
  }

  /** Current window occupancy for a developer. Intended for ops and tests. */
  usage(developerId: string, windowMs: number, now = Date.now()): number {
    return (this.windows.get(developerId) ?? []).filter(
      (at) => at > now - windowMs,
    ).length;
  }

  /** Clears all in-process counters. Intended for tests and ops tooling. */
  reset(): void {
    this.windows.clear();
  }

  /**
   * Deletes `RateLimitRecord` rows whose window has closed.
   *
   * Only rows with `windowStart < now - windowMs` are removed: a row for the
   * current window is still enforcing a limit, and deleting it early would
   * silently hand a developer a fresh quota.
   *
   * Fail-closed: a database outage raises a typed error rather than reporting a
   * misleading "0 deleted".
   */
  async cleanupOldRecords(
    windowMs: number = DEFAULT_DEVELOPER_QUOTA_WINDOW_MS,
    batchSize: number = DEFAULT_QUOTA_CLEANUP_BATCH_SIZE,
    now: Date = new Date(),
  ): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      this.metrics.incrementCounter('developer_quota_cleanup_invalid_batch');
      throw Object.assign(new Error('batchSize must be a positive integer'), {
        code: DeveloperQuotaErrorCode.CLEANUP_INVALID_BATCH_SIZE,
      });
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      this.metrics.incrementCounter('developer_quota_cleanup_invalid_window');
      throw Object.assign(new Error('windowMs must be a positive number'), {
        code: DeveloperQuotaErrorCode.CLEANUP_INVALID_BATCH_SIZE,
      });
    }

    const limit = Math.min(batchSize, MAX_QUOTA_CLEANUP_BATCH_SIZE);
    const cutoff = new Date(now.getTime() - windowMs);

    let deleted: { count: number };
    try {
      deleted = await this.store.rateLimitRecord.deleteMany({
        where: { windowStart: { lt: cutoff } },
        take: limit,
      });
    } catch (err) {
      this.metrics.incrementCounter(
        'developer_quota_cleanup_dependency_unavailable',
      );
      this.logger.error(
        'Developer quota cleanup failed: database unavailable',
        err instanceof Error ? err.constructor.name : 'unknown',
      );
      throw Object.assign(
        new Error('Developer quota cleanup failed: database unavailable'),
        { code: DeveloperQuotaErrorCode.CLEANUP_DEPENDENCY_UNAVAILABLE },
      );
    }

    const count = deleted?.count ?? 0;
    this.metrics.incrementCounter('developer_quota_cleanup_deleted', count);
    if (count > 0) {
      this.logger.log(
        `Developer quota cleanup: deleted ${count} expired record(s) ` +
          `(cutoff=${cutoff.toISOString()}, batchLimit=${limit})`,
      );
    }
    return count;
  }

  /**
   * Stores a window, evicting the oldest entry when the map is at capacity.
   *
   * Eviction costs a developer a fresh window, never a denial, so a flood of
   * distinct ids degrades accounting accuracy rather than availability.
   */
  private storeWindow(developerId: string, timestamps: number[]): void {
    if (
      !this.windows.has(developerId) &&
      this.windows.size >= MAX_TRACKED_DEVELOPERS
    ) {
      const oldest = this.windows.keys().next();
      if (!oldest.done) {
        this.windows.delete(oldest.value);
        this.metrics.incrementCounter('developer_quota_window_evicted');
      }
    }
    this.windows.set(developerId, timestamps);
  }
}
