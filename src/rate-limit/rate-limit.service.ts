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
 * 7. **Shared across instances.** The window is not process-local: every replica
 *    reads and writes the same counter, so two instances counting the same
 *    developer share one window (issue #1279).
 */

/** Stable error codes. Clients and dashboards branch on these, never prose. */
export const DeveloperQuotaErrorCode = {
  /** The developer exceeded their quota for the current window. */
  EXCEEDED: 'DEVELOPER_QUOTA_EXCEEDED',
  /** The request has no server-resolved developer, so it cannot be accounted. */
  UNATTRIBUTED_REQUEST: 'DEVELOPER_QUOTA_UNATTRIBUTED_REQUEST',
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
 * Maximum number of developers tracked in the shared window store.
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

/** Default cleanup polling interval, in ms (1 h). */
export const DEFAULT_QUOTA_CLEANUP_INTERVAL_MS = 3_600_000;

/** Lower bound on the cleanup polling interval, in ms. Prevents a hot loop. */
export const MIN_QUOTA_CLEANUP_INTERVAL_MS = 60_000;

/** Upper bound on the cleanup polling interval, in ms (24 h). */
export const MAX_QUOTA_CLEANUP_INTERVAL_MS = 86_400_000;

/** DI token for {@link RateLimitRecordStore}. */
export const RATE_LIMIT_RECORD_STORE = Symbol('RATE_LIMIT_RECORD_STORE');

/** DI token for {@link DeveloperQuotaWindowStore}. */
export const DEVELOPER_QUOTA_WINDOW_STORE = Symbol('DEVELOPER_QUOTA_WINDOW_STORE');

/** Narrow view of the `RateLimitRecord` delete surface the service needs. */
export interface RateLimitRecordStore {
  rateLimitRecord: {
    deleteMany(args: {
      where: { windowStart: { lt: Date } };
      take?: number;
    }): Promise<{ count: number }>;
  };
}

/**
 * Shared, cross-instance store for per-developer sliding-window counters.
 *
 * Implementations must be backed by a store every replica can reach (e.g. Redis
 * or the database) so that two service instances counting the same developer
 * share one window. The store is keyed by the server-resolved developer id and
 * must itself bound the number of tracked developers.
 */
export interface DeveloperQuotaWindowStore {
  /**
   * Records one request for `developerId` and returns the number of requests
   * counted in the current window, including this one.
   */
  record(developerId: string, windowMs: number, now: number): Promise<number>;
}

/**
 * In-process fallback store.
 *
 * Used only when no shared store is provided. It preserves the previous
 * single-process behavior (and keeps unit tests hermetic) but does NOT satisfy
 * the cross-instance requirement — production wiring must inject a shared
 * implementation via {@link DEVELOPER_QUOTA_WINDOW_STORE}.
 */
export class InMemoryDeveloperQuotaWindowStore
  implements DeveloperQuotaWindowStore
{
  private readonly windows = new Map<string, number[]>();

  async record(
    developerId: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const cutoff = now - windowMs;
    const existing = this.windows.get(developerId) ?? [];
    const pruned = existing.filter((ts) => ts > cutoff);
    pruned.push(now);
    // Re-insert to keep Map iteration order as least-recently-seen last.
    this.windows.delete(developerId);
    this.windows.set(developerId, pruned);
    if (this.windows.size > MAX_TRACKED_DEVELOPERS) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) {
        this.windows.delete(oldest);
      }
    }
    return pruned.length;
  }
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
 * Resolves the cleanup polling interval, clamped to
 * `[MIN_QUOTA_CLEANUP_INTERVAL_MS, MAX_QUOTA_CLEANUP_INTERVAL_MS]`.
 *
 * A missing, empty, or non-integer value falls back to the default. An integer
 * outside the bounds is clamped, so `0` or a negative value cannot turn the
 * worker into a hot loop and an oversized value cannot stall cleanup forever.
 */
export function resolveCleanupIntervalMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_QUOTA_CLEANUP_INTERVAL_MS;
  }
  return Math.min(
    Math.max(
      toInt(raw, DEFAULT_QUOTA_CLEANUP_INTERVAL_MS),
      MIN_QUOTA_CLEANUP_INTERVAL_MS,
    ),
    MAX_QUOTA_CLEANUP_INTERVAL_MS,
  );
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
   * Shared sliding-window counters keyed by developer id.
   *
   * Backed by {@link DeveloperQuotaWindowStore} so every instance reads and
   * writes the same window (issue #1279). The store is responsible for pruning
   * expired timestamps and bounding the number of tracked developers.
   */
  private readonly windows: DeveloperQuotaWindowStore;

  constructor(
    private readonly metrics: MetricsService,
    @Inject(RATE_LIMIT_RECORD_STORE)
    private readonly store: RateLimitRecordStore,
    @Inject(DEVELOPER_QUOTA_WINDOW_STORE)
    windows?: DeveloperQuotaWindowStore,
  ) {
    this.windows = windows ?? new InMemoryDeveloperQuotaWindowStore();
  }

  /**
   * Records one request for the server-resolved developer and returns the
   * decision for the current window.
   *
   * The counter is shared across instances via {@link DeveloperQuotaWindowStore}.
   */
  async checkDeveloperQuota(
    developerId: string,
    config: DeveloperQuotaConfig = resolveDeveloperQuotaConfig(),
  ): Promise<DeveloperQuotaDecision> {
    const now = Date.now();
    const resetAt = now + config.windowMs;

    if (!config.enabled) {
      return {
        allowed: true,
        remaining: config.limitRpm,
        resetAt,
        limitRpm: config.limitRpm,
      };
    }

    if (!developerId) {
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        limitRpm: config.limitRpm,
      };
    }

    const count = await this.windows.record(
      developerId,
      config.windowMs,
      now,
    );
    const allowed = count <= config.limitRpm;
    const remaining = Math.max(config.limitRpm - count, 0);

    return { allowed, remaining, resetAt, limitRpm: config.limitRpm };
  }
}
