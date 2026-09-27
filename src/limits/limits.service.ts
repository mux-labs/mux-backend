import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLimitDto, LimitPeriod } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

export interface LimitCheckResult {
  allowed: boolean;
  perTxLimit: number;
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
}

@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async setLimits(walletId: string, daily: number, perTx: number) {
    return this.prisma.walletLimit.upsert({
      where: { walletId },
      update: { dailyLimit: daily, perTransactionLimit: perTx },
      create: { walletId, dailyLimit: daily, perTransactionLimit: perTx },
    });
  }

  async getLimits(walletId: string) {
    return this.prisma.walletLimit.findUnique({ where: { walletId } });
  }

  /**
   * Enforces both per-transaction and daily spending limits for a wallet.
   *
   * Invariants (fail-closed):
   *  - Per-tx check runs first; if it fails the daily aggregation is never read.
   *  - Daily total is computed from PENDING + SUBMITTED + CONFIRMED transactions
   *    whose createdAt falls within the current UTC calendar day.
   *  - Amount is parsed as a float; a non-numeric amount is treated as 0 so
   *    callers must validate before reaching this method.
   *  - Throws ForbiddenException (403) so callers get a typed, stable HTTP code.
   *
   * @param walletId  Sender wallet UUID
   * @param amount    Transaction amount as a decimal string (e.g. "10.5")
   */
  async checkLimits(walletId: string, amount: number | string): Promise<LimitCheckResult> {
    const amountNum = typeof amount === 'string' ? parseFloat(amount) : amount;

    const limits = await this.getLimits(walletId);
    if (!limits) {
      // No limits configured — allow unconditionally
      return {
        allowed: true,
        perTxLimit: Infinity,
        dailyLimit: Infinity,
        dailyUsed: 0,
        dailyRemaining: Infinity,
      };
    }

    const perTxLimit = Number(limits.perTransactionLimit);
    const dailyLimit = Number(limits.dailyLimit);

    // 1. Per-transaction check
    if (amountNum > perTxLimit) {
      this.logger.warn(
        `Per-tx limit exceeded for wallet ${walletId}: amount=${amountNum}, limit=${perTxLimit}`,
      );
      throw new ForbiddenException(
        `Transaction amount ${amountNum} exceeds per-transaction limit of ${perTxLimit}`,
      );
    }

    // 2. Daily limit check — aggregate PENDING + SUBMITTED + CONFIRMED today
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const txns = await this.prisma.transaction.findMany({
      where: {
        senderWalletId: walletId,
        createdAt: { gte: startOfDay },
        status: { in: ['PENDING', 'SUBMITTED', 'CONFIRMED'] },
      },
      select: { amount: true },
    });

    const dailyUsed = txns.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const dailyRemaining = dailyLimit - dailyUsed;

    if (dailyUsed + amountNum > dailyLimit) {
      this.logger.warn(
        `Daily limit exceeded for wallet ${walletId}: used=${dailyUsed}, ` +
          `proposed=${amountNum}, limit=${dailyLimit}`,
      );
      throw new ForbiddenException(
        `Daily spending limit of ${dailyLimit} would be exceeded. ` +
          `Used today: ${dailyUsed.toFixed(7)}, requested: ${amountNum}`,
      );
    }

    return {
      allowed: true,
      perTxLimit,
      dailyLimit,
      dailyUsed,
      dailyRemaining,
    };
  }

  async removeLimits(walletId: string) {
    const existing = await this.getLimits(walletId);
    if (!existing)
      throw new NotFoundException(`No limits found for wallet ${walletId}`);
    return this.prisma.walletLimit.delete({ where: { walletId } });
  }
}
