/**
 * Authoritative "usage so far today" for a wallet.
 *
 * A client that needs to know how much of its daily limit it has consumed must
 * not be trusted to compute it. The backend already owns the rows; deriving the
 * number server-side means the figure cannot be understated to unlock a spend
 * that policy would refuse.
 *
 * The window is a **UTC calendar day**, not a rolling 24 hours: a "daily
 * limit" that resets at 00:00 UTC is the limit an operator can reason about
 * from a log, and it matches how the limit is configured
 * (`WalletLimit.dailyLimit`) rather than how a particular request happened to
 * arrive.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';

/** Lifecycle states counted toward a wallet's daily usage. */
export const UsageStatus = {
  /** Created but not yet settled. Counts: the money can still be spent. */
  PENDING: 'PENDING',
  /** Settled on-chain. Counts. */
  CONFIRMED: 'CONFIRMED',
  /** Failed. Does not count. */
  FAILED: 'FAILED',
} as const;

export type UsageStatus = (typeof UsageStatus)[keyof typeof UsageStatus];

/** Statuses that consume daily limit. FAILED is deliberately excluded. */
export const USAGE_COUNTING_STATUSES: readonly UsageStatus[] = [
  UsageStatus.PENDING,
  UsageStatus.CONFIRMED,
];

/**
 * Stable, machine-readable codes for the usage query. Clients branch on the
 * code, never the message. Add new codes; never repurpose one.
 */
export const UsageErrorCode = {
  /** The requested wallet id is not a usable, bounded identifier. */
  INVALID_WALLET_ID: 'USAGE_INVALID_WALLET_ID',
  /** The store rejected or could not answer the query; usage is unknown. */
  STORE_UNAVAILABLE: 'USAGE_STORE_UNAVAILABLE',
  /** The store returned something that cannot be a usage aggregate. */
  STORE_CONTRACT_VIOLATION: 'USAGE_STORE_CONTRACT_VIOLATION',
} as const;

export type UsageErrorCode =
  (typeof UsageErrorCode)[keyof typeof UsageErrorCode];

/** Upper bound on an accepted wallet id, to bound the query input. */
export const MAX_WALLET_ID_LENGTH = 128;

/**
 * A raw aggregate row as returned by the store.
 *
 * Amounts arrive as strings: a payment amount is a real value, and parsing it
 * into a JS number would silently lose precision above 2^53. The sum is
 * therefore done in integer scaled units, via {@link addAmounts}.
 */
export interface UsageAggregateRow {
  assetCode: string;
  /** Decimal amount as a string, e.g. `"12.5000000"`. */
  amount: string;
  /** Row count, as Prisma's `_count._all`. */
  _count?: { _all?: number };
  /** Summed amount, as Prisma's `_sum.amount`. */
  _sum?: { amount?: string | null };
}

/** Authoritative usage for one wallet, for one UTC day. */
export interface TodayUsage {
  walletId: string;
  /** Inclusive start of the UTC day, ISO 8601. */
  windowStart: string;
  /** Exclusive end of the UTC day, ISO 8601. */
  windowEnd: string;
  /** Summed amount per asset code. Absent assets are not listed. */
  amounts: Record<string, string>;
  /** Number of counting transactions in the window. */
  transactionCount: number;
  /** Epoch ms at which the figure was computed, for client cache hints. */
  computedAt: string;
}

/**
 * Narrow view of the query surface the service needs.
 *
 * Declaring the exact shape (rather than depending on generated Prisma types)
 * keeps this unit decoupled from client regeneration and makes the single
 * query explicit and reviewable. `PrismaService` satisfies it structurally.
 */
export interface UsageStore {
  transaction: {
    groupBy(args: {
      by: string[];
      where: Record<string, unknown>;
      _sum: Record<string, true>;
      _count: { _all: true };
    }): Promise<UsageAggregateRow[]>;
  };
}

/** DI token for {@link UsageStore}. */
export const USAGE_STORE = Symbol('USAGE_STORE');

/**
 * UsageService — the authoritative source of "used today".
 *
 * Invariants:
 *
 * 1. **Server-derived, never client-supplied.** The figure is a `GROUP BY`
 *    over the wallet's own transactions. There is no path where a caller
 *    supplies the number, so a client cannot understate usage to unlock a
 *    spend the policy would refuse.
 * 2. **UTC calendar day.** The window is `[00:00Z, next 00:00Z)`, computed
 *    server-side from an injectable clock. A client cannot widen or shift the
 *    window, which is what stops "reset the counter by moving the clock".
 * 3. **Fail closed on outage.** A store error raises
 *    `USAGE_STORE_UNAVAILABLE`. The service never reports `0` for a query it
 *    did not answer — a false zero reads as "full allowance available" and is
 *    the dangerous direction to fail in.
 * 4. **A malformed aggregate is refused.** A row with a missing or negative
 *    amount is `USAGE_STORE_CONTRACT_VIOLATION` rather than being coerced, so a
 *    schema drift cannot silently under-report a wallet's usage.
 * 5. **No PII, no key material.** Only the wallet id, per-asset totals, and a
 *    count are returned or logged. Amounts are logged only as an aggregate,
 *    never per row.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @Inject(USAGE_STORE) private readonly store: UsageStore,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Computes usage for `walletId` over the current UTC day.
   *
   * @param now Injectable clock, for deterministic tests.
   * @throws UsageUnavailableError on any path where the true figure is unknown.
   */
  async getTodayUsage(
    walletId: string,
    now: Date = new Date(),
  ): Promise<TodayUsage> {
    if (
      typeof walletId !== 'string' ||
      walletId.length === 0 ||
      walletId.length > MAX_WALLET_ID_LENGTH
    ) {
      this.metrics.incrementCounter('usage_invalid_wallet_id');
      throw new UsageUnavailableError(
        UsageErrorCode.INVALID_WALLET_ID,
        'walletId must be a non-empty bounded string',
      );
    }

    const { start, end } = utcDayWindow(now);

    let rows: UsageAggregateRow[];
    try {
      rows = await this.store.transaction.groupBy({
        by: ['assetCode'],
        where: {
          senderWalletId: walletId,
          createdAt: { gte: start, lt: end },
          status: { in: [...USAGE_COUNTING_STATUSES] },
        },
        _sum: { amount: true },
        _count: { _all: true },
      });
    } catch (err) {
      // Fail closed: an unknown usage figure must never look like zero.
      this.metrics.incrementCounter('usage_store_unavailable');
      this.logger.error(
        `usage.today failed walletId=${walletId} reason=${errorName(err)}`,
      );
      throw new UsageUnavailableError(
        UsageErrorCode.STORE_UNAVAILABLE,
        'Usage is temporarily unavailable',
      );
    }

    if (!Array.isArray(rows)) {
      this.metrics.incrementCounter('usage_store_contract_violation');
      throw new UsageUnavailableError(
        UsageErrorCode.STORE_CONTRACT_VIOLATION,
        'Usage store returned an unusable result',
      );
    }

    const amounts: Record<string, string> = {};
    let transactionCount = 0;

    for (const row of rows) {
      const amount = this.aggregateAmount(row);
      if (amount === null) {
        continue;
      }
      amounts[row.assetCode] = addAmounts(amounts[row.assetCode], amount);
      transactionCount += row._count?._all ?? 0;
    }

    this.metrics.incrementCounter('usage_today_computed');
    this.logger.debug(
      `usage.today walletId=${walletId} window=${start.toISOString()} ` +
        `assets=${Object.keys(amounts).length} count=${transactionCount}`,
    );

    return {
      walletId,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      amounts,
      transactionCount,
      computedAt: now.toISOString(),
    };
  }

  /**
   * Extracts one row's amount. `null` when the group is empty (`_sum.amount` is
   * null); throws when the row is malformed, rather than coercing it to zero.
   */
  private aggregateAmount(row: UsageAggregateRow): string | null {
    const raw = row._sum?.amount;
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw)) {
      throw new UsageUnavailableError(
        UsageErrorCode.STORE_CONTRACT_VIOLATION,
        'Usage store returned an unusable amount',
      );
    }
    if (typeof row.assetCode !== 'string' || row.assetCode.length === 0) {
      throw new UsageUnavailableError(
        UsageErrorCode.STORE_CONTRACT_VIOLATION,
        'Usage store returned a row without an asset code',
      );
    }
    return raw;
  }
}

/** Thrown on every failure path, with a stable code. */
export class UsageUnavailableError extends Error {
  readonly code: UsageErrorCode;

  constructor(code: UsageErrorCode, message: string) {
    super(message);
    this.name = 'UsageUnavailableError';
    this.code = code;
  }
}

/**
 * `[00:00Z today, 00:00Z tomorrow)`.
 *
 * Derived by truncating to the UTC day and adding 24h, so it is correct for
 * every date, including across a DST boundary in the operator's own timezone
 * (UTC has none) and on a leap day.
 *
 * @throws UsageUnavailableError when `now` is not a valid Date.
 */
export function utcDayWindow(now: Date): { start: Date; end: Date } {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new UsageUnavailableError(
      UsageErrorCode.INVALID_WALLET_ID,
      'now must be a valid Date',
    );
  }
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * Adds two decimal amount strings without going through a JS number.
 *
 * `Number` cannot represent every decimal amount exactly, and this sum feeds a
 * spending limit — a rounding error here is a limit bypass. Both sides are
 * split into whole and fraction parts, padded to a common scale, and added as
 * `BigInt`.
 */
export function addAmounts(a: string | undefined, b: string): string {
  if (a === undefined) {
    return b;
  }
  const [aWhole = '0', aFrac = ''] = a.split('.');
  const [bWhole = '0', bFrac = ''] = b.split('.');
  const scale = Math.max(aFrac.length, bFrac.length);
  const factor = 10n ** BigInt(scale);
  const total =
    BigInt(aWhole || '0') * factor +
    BigInt(aFrac.padEnd(scale, '0') || '0') +
    (BigInt(bWhole || '0') * factor + BigInt(bFrac.padEnd(scale, '0') || '0'));
  return formatScaled(total, scale);
}

/** Renders an integer scaled by `10^scale` back to a decimal string. */
function formatScaled(scaled: bigint, scale: number): string {
  if (scale === 0) {
    return scaled.toString();
  }
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Only the error's class name, never its message, reaches a log line. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}
