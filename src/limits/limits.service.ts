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

@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  private async getDailyLimit(walletId: string): Promise<number> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: { dailyLimit: true },
    });
    const limit = Number(wallet?.dailyLimit);
    return Number.isFinite(limit) ? limit : 0;
  }
}
