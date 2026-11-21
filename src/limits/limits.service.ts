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
 * Matches a non-negative decimal string or integer, e.g. "0", "10", "10.10".
 * Rejects signs, exponents, whitespace, and anything that is not a plain
 * decimal so the value can be persisted verbatim without float coercion.
 */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  /**
   * Checks the daily spending limit for a wallet.
   *
   * Policy: rows whose `amount` cannot be parsed into a finite number are
   * skipped with a warning log (skip-with-warning). This prevents a single
   * malformed `Transaction.amount` row from poisoning the daily aggregation
   * into `NaN` and silently disabling the daily limit. `dailyUsed` and
   * `dailyRemaining` returned to callers are therefore always finite numbers.
   *
   * The requested `amount` must be a finite, positive number; anything else
   * (NaN, Infinity, negative, zero, or an unparseable string) fails closed
   * with a `BadRequestException` before any limit lookup occurs.
   */
  async checkLimits(walletId: string, amount: string): Promise<LimitCheckResult> {
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new BadRequestException(
        `Invalid amount: ${String(amount)} must be a finite, positive number`,
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

    let dailyUsed = 0;
    for (const t of txns) {
      const parsed = Number(t.amount);
      if (!Number.isFinite(parsed)) {
        this.logger.warn(
          `Skipping transaction id=${t.id} with unparseable amount=${String(t.amount)}`,
        );
        continue;
      }
      dailyUsed += parsed;
    }

    if (dailyUsed + amountNum > dailyLimit) {
      throw new ForbiddenException(
        `Daily limit exceeded: used ${dailyUsed} + ${amountNum} > ${dailyLimit}`,
      );
    }

    return {
      allowed: true,
      dailyUsed,
      dailyRemaining: dailyLimit - dailyUsed,
      dailyLimit,
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
   * Validates a limit as a non-negative decimal string or integer and returns
   * it unchanged so it can be persisted without float coercion.
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
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: { dailyLimit: true },
    });
    const limit = Number(wallet?.dailyLimit);
    return Number.isFinite(limit) ? limit : 0;
  }
}
