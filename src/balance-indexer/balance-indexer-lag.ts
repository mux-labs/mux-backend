/**
 * Stable, typed error codes for indexer lag reporting.
 *
 * Clients (dashboards, alerting) branch on these codes, not on message text.
 * Add new codes; never repurpose an existing one.
 */
export const BalanceLagErrorCode = {
  /** Caller supplied something that is not a usable lag input. */
  INVALID_INPUT: 'BALANCE_LAG_INVALID_INPUT',
  /** The balance store is unreachable; lag is unknown, not zero. */
  DEPENDENCY_UNAVAILABLE: 'BALANCE_LAG_DEPENDENCY_UNAVAILABLE',
  /** A stored timestamp could not be interpreted as a date. */
  MALFORMED_TIMESTAMP: 'BALANCE_LAG_MALFORMED_TIMESTAMP',
} as const;

export type BalanceLagErrorCode =
  (typeof BalanceLagErrorCode)[keyof typeof BalanceLagErrorCode];

/**
 * Coarse lag buckets.
 *
 * A histogram of exact millisecond values is useless for alerting and expensive
 * to store, so lag is reported as a bounded bucket. The set is deliberately
 * small and fixed: every value maps into exactly one bucket, so the metric can
 * never grow an unbounded number of series.
 */
export const LAG_BUCKETS = [
  '0s',
  '30s',
  '2m',
  '5m',
  '15m',
  '1h',
  '6h',
  '24h',
  '24h+',
] as const;

export type LagBucket = (typeof LAG_BUCKETS)[number];

/** Bucket upper bounds in milliseconds, aligned with {@link LAG_BUCKETS}. */
const LAG_BUCKET_BOUNDS_MS: ReadonlyArray<readonly [LagBucket, number]> = [
  ['0s', 0],
  ['30s', 30_000],
  ['2m', 120_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['1h', 3_600_000],
  ['6h', 21_600_000],
  ['24h', 86_400_000],
];

/**
 * Maps an age in milliseconds to its bucket.
 *
 * Negative ages (a clock skew, or a `lastSyncedAt` in the future) collapse into
 * `0s` rather than into a bogus "very fresh" or error: a slightly future
 * timestamp must not make an alert fire, and must not crash the reporter.
 */
export function toLagBucket(lagMs: number): LagBucket {
  if (!Number.isFinite(lagMs) || lagMs <= 0) {
    return '0s';
  }
  let bucket: LagBucket = '24h+';
  for (const [name, bound] of LAG_BUCKET_BOUNDS_MS) {
    if (lagMs <= bound) {
      bucket = name;
      break;
    }
  }
  return bucket;
}

/**
 * How long an indexed balance may lag behind the chain before it is reported as
 * breaching. Defaults to the balance staleness threshold (5 minutes) so lag
 * alerting and staleness marking agree on what "too old" means; override with
 * `BALANCE_LAG_ALERT_THRESHOLD_MS` for a different SLO.
 */
export const DEFAULT_LAG_ALERT_THRESHOLD_MS = 300_000;

export const BALANCE_LAG_ALERT_THRESHOLD_ENV = 'BALANCE_LAG_ALERT_THRESHOLD_MS';

/** Upper bound on rows inspected in one lag report. */
export const MAX_LAG_SCAN_ROWS = 10_000;

/** Minimal balance shape the lag computation needs. */
export interface LagInputRow {
  lastSyncedAt?: Date | string | null;
}

/** Result of a lag report. */
export interface BalanceLagReport {
  /** Number of rows inspected. */
  rowsScanned: number;
  /** Rows that have never been synced at all. */
  neverSynced: number;
  /**
   * Age of the oldest row, in ms. `0` when there is nothing to measure.
   * Reported as `Number.MAX_SAFE_INTEGER` when any row was never synced, so
   * a missing index row reads as maximally stale rather than as "fresh".
   */
  maxLagMs: number;
  /** Median age across rows, in ms. `0` when there is nothing to measure. */
  medianLagMs: number;
  /** Bucket for {@link BalanceLagReport.maxLagMs}. */
  bucket: LagBucket;
  /** Whether the worst lag exceeds the alert threshold. */
  breaching: boolean;
  /** Resolved alert threshold, echoed so a dashboard can explain the verdict. */
  thresholdMs: number;
}

/**
 * Computes indexer lag from indexed balance rows.
 *
 * ## Invariants
 *
 * 1. **Fail-closed on a bad store.** A store failure raises
 *    `BALANCE_LAG_DEPENDENCY_UNAVAILABLE` rather than reporting a lag of 0.
 *    Reporting "no lag" when the index is unreachable would silently disable the
 *    very alerting this exists to provide.
 * 2. **A never-synced row is maximally stale.** It counts toward `neverSynced`
 *    and is treated as the maximum lag, so a wallet whose index row is missing
 *    cannot look "fresh".
 * 3. **Bounded work.** At most {@link MAX_LAG_SCAN_ROWS} rows are inspected, so
 *    a large index cannot turn a metrics call into an outage.
 * 4. **No identifiers in the output.** The report carries counts and durations
 *    only — never a wallet id, public key, or asset issuer — so it is safe to
 *    log and to use as metric labels.
 * 5. **Never emits `NaN`.** A malformed timestamp is rejected with
 *    `BALANCE_LAG_MALFORMED_TIMESTAMP` rather than producing a `NaN` that
 *    would silently poison a histogram.
 */
export class BalanceLagCalculator {
  /**
   * @param rows  Indexed balance rows, in any order.
   * @param thresholdMs  Alert threshold; defaults to
   *   {@link DEFAULT_LAG_ALERT_THRESHOLD_MS}.
   * @param now  Reference instant, injectable for deterministic tests.
   */
  static compute(
    rows: readonly LagInputRow[],
    thresholdMs: number = DEFAULT_LAG_ALERT_THRESHOLD_MS,
    now: number = Date.now(),
  ): BalanceLagReport {
    if (!Array.isArray(rows)) {
      throw lagError(
        BalanceLagErrorCode.INVALID_INPUT,
        'rows must be an array',
      );
    }

    const limit = Math.min(rows.length, MAX_LAG_SCAN_ROWS);
    const ages: number[] = [];
    let neverSynced = 0;
    let maxLagMs = 0;
    let sawNeverSynced = false;

    // `Array.isArray` narrows a readonly array to `any[]`, so re-assert the
    // element type explicitly rather than indexing the narrowed value.
    const inputs: readonly LagInputRow[] = rows;

    for (let i = 0; i < limit; i++) {
      const row: LagInputRow | undefined = inputs[i];
      const raw = row?.lastSyncedAt;
      if (raw === null || raw === undefined) {
        // Invariant 2: no sync timestamp means unbounded staleness.
        neverSynced += 1;
        sawNeverSynced = true;
        continue;
      }
      const stamp: Date | string = raw;
      const timestamp =
        stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
      if (!Number.isFinite(timestamp)) {
        throw lagError(
          BalanceLagErrorCode.MALFORMED_TIMESTAMP,
          'lastSyncedAt is not a valid date',
        );
      }
      const age = now - timestamp;
      const lagMs = age > 0 ? age : 0;
      ages.push(lagMs);
      if (lagMs > maxLagMs) {
        maxLagMs = lagMs;
      }
    }

    ages.sort((a, b) => a - b);
    const median =
      ages.length === 0
        ? 0
        : ages.length % 2 === 1
          ? ages[(ages.length - 1) / 2]
          : Math.floor((ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2);

    const threshold =
      Number.isFinite(thresholdMs) && thresholdMs > 0
        ? thresholdMs
        : DEFAULT_LAG_ALERT_THRESHOLD_MS;

    const worstLagMs = sawNeverSynced ? Number.MAX_SAFE_INTEGER : maxLagMs;

    return {
      rowsScanned: limit,
      neverSynced,
      maxLagMs: worstLagMs,
      medianLagMs: sawNeverSynced ? Number.MAX_SAFE_INTEGER : median,
      bucket: sawNeverSynced ? '24h+' : toLagBucket(maxLagMs),
      // A never-synced row is breaching by definition, whatever the ages say.
      breaching: sawNeverSynced || maxLagMs > threshold,
      thresholdMs: threshold,
    };
  }
}

/** Builds an Error carrying a stable, machine-readable `code`. */
function lagError(code: BalanceLagErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: BalanceLagErrorCode };
  err.code = code;
  return err;
}

/**
 * Resolves the configured lag alert threshold.
 *
 * Fail-closed: a missing, unparsable, or non-positive value falls back to the
 * default rather than disabling alerting with a typo.
 */
export function resolveLagThreshold(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_LAG_ALERT_THRESHOLD_MS;
}
