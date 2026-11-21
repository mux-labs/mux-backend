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
  dailyLimit: number;
  perTransactionLimit: number;
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

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  constructor(private readonly prisma: PrismaService) {}

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
   * a `BadRequestException` before any limit lookup occurs.
   *
   * The daily limit is read from the same `walletLimit` row that `setLimits`
   * writes. A wallet with no limit row fails closed with a
   * `ForbiddenException` rather than being treated as a limit of 0.
   */
  async checkLimits(walletId: string, amount: string): Promise<LimitCheckResult> {
    const requested = this.parseDecimal(amount);
    if (!requested || requested.units <= 0n) {
      throw new BadRequestException(
        `Invalid amount: ${String(amount)} must be a positive decimal`,
      );
    }

    const dailyLimit = await this.getDailyLimit(walletId);

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const txns = await this.prisma.transaction.findMany({
      where: {
        walletId,
        createdAt: { gte: startOfDay },
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
   * Both values must be finite and non-negative; anything else (NaN,
   * Infinity, or a negative number) fails closed with a `BadRequestException`
   * naming the offending field before Prisma is touched. A negative limit
   * would otherwise make the corresponding guard true for every amount and
   * permanently block the wallet.
   */
  async setLimits(
    walletId: string,
    daily: number,
    perTx: number,
  ): Promise<WalletLimits> {
    if (!Number.isFinite(daily) || daily < 0) {
      throw new BadRequestException(
        `Invalid daily limit: ${String(daily)} must be a finite, non-negative number`,
      );
    }
    if (!Number.isFinite(perTx) || perTx < 0) {
      throw new BadRequestException(
        `Invalid per-transaction limit: ${String(perTx)} must be a finite, non-negative number`,
      );
    }

    const limits = await this.prisma.walletLimit.upsert({
      where: { walletId },
      update: { dailyLimit: daily, perTransactionLimit: perTx },
      create: { walletId, dailyLimit: daily, perTransactionLimit: perTx },
    });

    return {
      dailyLimit: Number(limits.dailyLimit),
      perTransactionLimit: Number(limits.perTransactionLimit),
    };
  }

  /**
   * Returns the persisted limits for a wallet, or `null` when no row exists.
   */
  async getLimits(walletId: string): Promise<WalletLimits | null> {
    const limits = await this.prisma.walletLimit.findUnique({
      where: { walletId },
    });
    if (!limits) {
      return null;
    }
    return {
      dailyLimit: Number(limits.dailyLimit),
      perTransactionLimit: Number(limits.perTransactionLimit),
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
