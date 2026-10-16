import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LimitCheckResult {
  allowed: boolean;
  dailyUsed: number;
  dailyRemaining: number;
  dailyLimit: number;
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

  private async getDailyLimit(walletId: string): Promise<number> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: { dailyLimit: true },
    });
    const limit = Number(wallet?.dailyLimit);
    return Number.isFinite(limit) ? limit : 0;
  }
}
