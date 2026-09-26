import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Narrow structural view of the `IdempotencyRecord` delete surface.
 *
 * Declaring the exact shape the service needs (rather than depending on the
 * generated Prisma client types) keeps this unit decoupled from client
 * regeneration, and makes the one query it performs explicit and reviewable.
 * `PrismaService` satisfies this interface structurally.
 */
export interface IdempotencyRecordStore {
  idempotencyRecord: {
    deleteMany(args: {
      where: { expiresAt: { lt: Date } };
    }): Promise<{ count: number }>;
  };
}

/**
 * Stable, ops-safe error codes for idempotency TTL cleanup.
 *
 * These are part of the public contract: callers and dashboards match on the
 * code, never on the human-readable message.
 */
export const IdempotencyCleanupErrorCode = {
  /** The database rejected the cleanup query — nothing was deleted. */
  DEPENDENCY_UNAVAILABLE: 'IDEMPOTENCY_CLEANUP_DEPENDENCY_UNAVAILABLE',
  /** The configured batch size was invalid (non-positive / non-finite). */
  INVALID_BATCH_SIZE: 'IDEMPOTENCY_CLEANUP_INVALID_BATCH_SIZE',
} as const;

export type IdempotencyCleanupErrorCode =
  (typeof IdempotencyCleanupErrorCode)[keyof typeof IdempotencyCleanupErrorCode];

/** Default number of rows deleted per cleanup pass. */
export const DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE = 1000;

/**
 * Upper bound on rows deleted in a single pass.
 *
 * Cleanup is a background concern; bounding the batch keeps a single
 * `DELETE` from holding a long transaction and blocking writes on the
 * money path (a griefing/DoS vector if the table has drifted far behind).
 */
export const MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE = 10_000;

/**
 * Result of one cleanup pass. Safe to log: counts and booleans only, never
 * keys, request bodies, or cached response payloads.
 */
export interface IdempotencyCleanupResult {
  /** Number of expired rows deleted in this pass. */
  deleted: number;
  /** True when a full batch was deleted, i.e. more expired rows may remain. */
  hasMore: boolean;
  /** Epoch ms cutoff used for this pass (`expiresAt < cutoff`). */
  cutoff: string;
}

/**
 * DI token for {@link IdempotencyRecordStore}.
 *
 * `PrismaService` structurally satisfies the store interface, so the module
 * binds this token to it. Using an explicit token keeps the service free of a
 * hard dependency on the generated Prisma client types.
 */
export const IDEMPOTENCY_RECORD_STORE = Symbol('IDEMPOTENCY_RECORD_STORE');

/**
 * IdempotencyService
 *
 * Owns the lifecycle of `IdempotencyRecord` rows.
 *
 * Invariants:
 *  - **TTL is the source of truth for expiry.** A record is expired when
 *    `expiresAt < now`. Nothing else may delete a still-valid record: doing so
 *    would re-open the duplicate-write window that idempotency exists to close.
 *  - **Bounded batches.** Each pass deletes at most
 *    `MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE` rows so cleanup cannot monopolize
 *    the database.
 *  - **Fail-closed on outage.** A database error propagates as a typed
 *    `DEPENDENCY_UNAVAILABLE` error. Cleanup never reports a successful delete
 *    count it did not achieve, and it never swallows an outage as "0 deleted".
 *  - **No secret leakage.** Return values and logs carry counts and cutoffs
 *    only — never idempotency keys, cached response bodies, or key material.
 *  - **Replay-safe.** Running cleanup concurrently or repeatedly is safe: each
 *    pass deletes a disjoint set of rows and re-running simply deletes fewer.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @Inject(IDEMPOTENCY_RECORD_STORE)
    private readonly store: IdempotencyRecordStore,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Deletes expired `IdempotencyRecord` rows.
   *
   * @param batchSize Max rows to delete in this pass. Clamped to
   *   `MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE`. Must be a positive integer.
   * @param now Injectable clock, for deterministic tests.
   * @throws Error with code `IDEMPOTENCY_CLEANUP_INVALID_BATCH_SIZE` when
   *   `batchSize` is not a positive integer.
   * @throws Error with code `IDEMPOTENCY_CLEANUP_DEPENDENCY_UNAVAILABLE` when
   *   the database is unreachable.
   */
  async cleanupExpiredRecords(
    batchSize: number = DEFAULT_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
    now: Date = new Date(),
  ): Promise<IdempotencyCleanupResult> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      this.metrics.incrementCounter(
        'idempotency.cleanup.invalid_batch_size',
        1,
      );
      throw Object.assign(new Error('batchSize must be a positive integer'), {
        code: IdempotencyCleanupErrorCode.INVALID_BATCH_SIZE,
      });
    }

    const limit = Math.min(batchSize, MAX_IDEMPOTENCY_CLEANUP_BATCH_SIZE);
    const cutoff = new Date(now.getTime());

    let deleted: { count: number };
    try {
      // `expiresAt < cutoff` — strictly expired only. A record whose TTL has
      // not elapsed is never touched, so a concurrent replay of a live request
      // still finds its cached result and cannot create a duplicate write.
      deleted = await this.store.idempotencyRecord.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      });
    } catch (err) {
      // Fail-closed: surface the outage with a stable code rather than
      // reporting a misleading "0 deleted" that looks like a healthy no-op.
      this.metrics.incrementCounter(
        'idempotency.cleanup.dependency_unavailable',
        1,
      );
      this.logger.error(
        'Idempotency cleanup failed: database unavailable',
        err instanceof Error ? err.message : String(err),
      );
      throw Object.assign(
        new Error('Idempotency cleanup failed: database unavailable'),
        { code: IdempotencyCleanupErrorCode.DEPENDENCY_UNAVAILABLE },
      );
    }

    const count = deleted?.count ?? 0;
    const hasMore = count >= limit;

    this.metrics.incrementCounter('idempotency.cleanup.deleted', count);
    if (count > 0) {
      this.logger.log(
        `Idempotency cleanup: deleted ${count} expired record(s) ` +
          `(cutoff=${cutoff.toISOString()}, batchLimit=${limit})`,
      );
    }

    return { deleted: count, hasMore, cutoff: cutoff.toISOString() };
  }
}
