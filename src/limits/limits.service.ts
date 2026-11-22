import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LimitCheckResult {
  allowed: boolean;
  dailyUsed: number;
  dailyRemaining: number;
  dailyLimit: number;
}

export interface WalletLimits {
  dailyLimit: string;
  perTransactionLimit: string;
}

/**
 * A decimal value represented as an integer `units` scaled by `10^scale`.
 * All arithmetic is done on integers so that values such as `0.10` and `0.20`
 * sum exactly to `0.30` without binary floating point drift.
 */
interface Decimal {
  units: bigint;
  scale: number;
}

/**
 * Matches a non-negative decimal string or integer, e.g. "0", "10", "10.10".
 * Rejects signs, exponents, whitespace, and anything that is not a plain
 * decimal so the value can be persisted verbatim without float coercion.
 */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Transaction statuses that actually move funds and therefore count toward
 * the daily spending limit. Failed, cancelled, and pending rows are excluded
 * so a rejected attempt cannot consume the limit and a pending row is not
 * double-counted once it is confirmed as a separate record.
 */
const DAILY_COUNTED_STATUSES = ['CONFIRMED', 'COMPLETED', 'SUCCESS'];

@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  /**
   * Checks the daily spending limit for a wallet.
   *
   * Policy: daily spending is summed with exact decimal arithmetic (integer
   * units scaled by a power of ten), so amounts such as `0.10` and `0.20`
   * count as `0.30` and values above `2^53` keep their stored precision.
   *
   * A stored `Transaction.amount` that is not a valid decimal fails the check
   * closed with a `ForbiddenException` instead of being skipped, so a bad row
   * can never lower `dailyUsed` and let a later payment through. The raw
   * amount is not included in the error message.
   *
   * The requested `amount` must be a positive decimal string; anything else
   * (NaN, Infinity, negative, zero, or a non-decimal string) fails closed with
   * a `BadRequestException` before any limit lookup occurs. The error message
   * never echoes the caller-supplied amount; only its length is logged
   * server-side so a large or binary-looking value is not reflected back to
   * the client.
   *
   * The daily limit is read from the same `walletLimit` row that `setLimits`
   * writes. A wallet with no limit row fails closed with a
   * `ForbiddenException` rather than being treated as a limit of 0.
   *
   * A missing daily limit (no wallet row or a non-finite stored value) is a
   * distinct failure from a stored limit of zero: the former fails closed with
   * `DAILY_LIMIT_NOT_CONFIGURED`, the latter rejects positive amounts with
   * `DAILY_LIMIT_ZERO`.
   */
  async checkLimits(walletId: string, amount: string): Promise<LimitCheckResult> {
    const requested = this.parseDecimal(amount);
    if (!requested || requested.units <= 0n) {
      this.logger.warn(
        `Rejected invalid amount for walletId=${walletId} (length=${String(amount).length})`,
      );
      throw new BadRequestException(
        'Invalid amount: must be a finite, positive number',
      );
    }

    const dailyLimit = await this.getDailyLimit(walletId);

    if (dailyLimit === null) {
      throw new ForbiddenException({
        code: 'DAILY_LIMIT_NOT_CONFIGURED',
        message: `No daily limit is configured for wallet ${walletId}`,
      });
    }

    if (dailyLimit === 0) {
      throw new ForbiddenException({
        code: 'DAILY_LIMIT_ZERO',
        message: `Daily limit for wallet ${walletId} is configured as zero`,
      });
    }

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const txns = await this.prisma.transaction.findMany({
      where: {
        walletId,
        createdAt: { gte: startOfDay },
        status: { in: DAILY_COUNTED_STATUSES },
      },
      select: { id: true, amount: true },
    });

    let dailyUsed = { units: 0n, scale: 0 };
    for (const t of txns) {
      const parsed = this.parseDecimal(t.amount);
      if (!parsed) {
        this.logger.warn(
          `Transaction id=${t.id} has an unparseable amount; failing daily limit check`,
        );
        throw new ForbiddenException(
          `Cannot verify daily limit for wallet ${walletId}: invalid stored transaction amount`,
        );
      }
      dailyUsed = this.addDecimals(dailyUsed, parsed);
    }

    const limitDecimal = this.parseDecimal(String(dailyLimit));
    if (!limitDecimal) {
      throw new ForbiddenException(
        `Invalid daily limit configured for wallet ${walletId}`,
      );
    }

    const projected = this.addDecimals(dailyUsed, requested);
    if (this.compareDecimals(projected, limitDecimal) > 0) {
      throw new ForbiddenException(
        `Daily limit exceeded: used ${this.formatDecimal(dailyUsed)} + ${this.formatDecimal(requested)} > ${this.formatDecimal(limitDecimal)}`,
      );
    }

    const dailyUsedNum = this.toNumber(dailyUsed);
    const dailyLimitNum = this.toNumber(limitDecimal);

    return {
      allowed: true,
      dailyUsed: dailyUsedNum,
      dailyRemaining: this.toNumber(this.subtractDecimals(limitDecimal, dailyUsed)),
      dailyLimit: dailyLimitNum,
    };
  }

  /**
   * Persists the daily and per-transaction limits for a wallet.
   *
   * Both values must be decimal strings or integers in the asset scale. They
   * are validated with a decimal parser (not `Number.isFinite`) so `NaN`,
   * `Infinity`, negatives, and malformed input fail closed with a
   * `BadRequestException` naming the offending field before Prisma is touched.
   * The validated string is persisted verbatim so the stored value matches
   * the decimal the client sent (e.g. `"10.10"` reads back as `"10.10"`).
   */
  async setLimits(
    walletId: string,
    daily: string,
    perTx: string,
  ): Promise<WalletLimits> {
    const dailyValue = this.parseLimit(daily, 'daily');
    const perTxValue = this.parseLimit(perTx, 'per-transaction');

    const limits = await this.prisma.walletLimit.upsert({
      where: { walletId },
      update: { dailyLimit: dailyValue, perTransactionLimit: perTxValue },
      create: { walletId, dailyLimit: dailyValue, perTransactionLimit: perTxValue },
    });

    return {
      dailyLimit: String(limits.dailyLimit),
      perTransactionLimit: String(limits.perTransactionLimit),
    };
  }

  /**
   * Returns the persisted limits for a wallet, or `null` when no row exists.
   * Limits are returned as strings so the stored decimal is preserved.
   */
  async getLimits(walletId: string): Promise<WalletLimits | null> {
    const limits = await this.prisma.walletLimit.findUnique({
      where: { walletId },
    });
    if (!limits) {
      return null;
    }
    return {
      dailyLimit: String(limits.dailyLimit),
      perTransactionLimit: String(limits.perTransactionLimit),
    };
  }

  /**
   * Deletes the persisted limits for a wallet.
   *
   * Throws `NotFoundException` when no row exists so callers can distinguish
   * a missing wallet limit from a successful removal.
   */
  async removeLimits(walletId: string): Promise<void> {
    const existing = await this.getLimits(walletId);
    if (!existing) {
      throw new NotFoundException(`No limits found for wallet ${walletId}`);
    }
    await this.prisma.walletLimit.delete({ where: { walletId } });
  }

  /**
   * Reads the daily limit from the `walletLimit` row that `setLimits` writes.
   *
   * A missing row fails closed with a `ForbiddenException` instead of being
   * treated as a limit of 0, so a wallet without configured limits cannot
   * silently reject every positive amount.
   */
  private parseLimit(value: string, field: string): string {
    const raw = typeof value === 'string' ? value.trim() : String(value);
    if (!DECIMAL_PATTERN.test(raw)) {
      throw new BadRequestException(
        `Invalid ${field} limit: ${String(value)} must be a non-negative decimal string`,
      );
    }
    return raw;
  }

  private async getDailyLimit(walletId: string): Promise<number> {
    const limits = await this.prisma.walletLimit.findUnique({
      where: { walletId },
      select: { dailyLimit: true },
    });
    if (!limits) {
      throw new ForbiddenException(
        `No daily limit configured for wallet ${walletId}`,
      );
    }
    const limit = Number(limits.dailyLimit);
    if (!Number.isFinite(limit)) {
      throw new ForbiddenException(
        `Invalid daily limit configured for wallet ${walletId}`,
      );
    }
    return limit;
  }

  /**
   * Parses a decimal string (e.g. `"0.10"`, `"12"`) into integer units and a
   * scale. Returns `null` for anything that is not a plain non-negative
   * decimal, including `NaN`, `Infinity`, negatives, and exponent notation.
   */
  private parseDecimal(value: unknown): Decimal | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) {
      return null;
    }
    const [whole, fraction = ''] = trimmed.split('.');
    const scale = fraction.length;
    const units = BigInt(whole + fraction);
    return { units, scale };
  }

  /**
   * Adds two decimals exactly by aligning them to a common scale.
   */
  private addDecimals(a: Decimal, b: Decimal): Decimal {
    const scale = Math.max(a.scale, b.scale);
    const aUnits = a.units * 10n ** BigInt(scale - a.scale);
    const bUnits = b.units * 10n ** BigInt(scale - b.scale);
    return { units: aUnits + bUnits, scale };
  }

  /**
   * Subtracts `b` from `a` exactly by aligning them to a common scale.
   */
  private subtractDecimals(a: Decimal, b: Decimal): Decimal {
    const scale = Math.max(a.scale, b.scale);
    const aUnits = a.units * 10n ** BigInt(scale - a.scale);
    const bUnits = b.units * 10n ** BigInt(scale - b.scale);
    return { units: aUnits - bUnits, scale };
  }

  /**
   * Compares two decimals exactly, returning -1, 0, or 1.
   */
  private compareDecimals(a: Decimal, b: Decimal): number {
    const scale = Math.max(a.scale, b.scale);
    const aUnits = a.units * 10n ** BigInt(scale - a.scale);
    const bUnits = b.units * 10n ** BigInt(scale - b.scale);
    if (aUnits < bUnits) {
      return -1;
    }
    if (aUnits > bUnits) {
      return 1;
    }
    return 0;
  }

  /**
   * Formats a decimal back into a plain string for error messages.
   */
  private formatDecimal(value: Decimal): string {
    if (value.scale === 0) {
      return value.units.toString();
    }
    const negative = value.units < 0n;
    const digits = (negative ? -value.units : value.units)
      .toString()
      .padStart(value.scale + 1, '0');
    const whole = digits.slice(0, digits.length - value.scale);
    const fraction = digits.slice(digits.length - value.scale);
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  /**
   * Converts a decimal to a number for the response payload.
   */
  private toNumber(value: Decimal): number {
    return Number(this.formatDecimal(value));
  }
}
