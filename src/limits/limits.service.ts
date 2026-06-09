import {
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLimitDto, LimitPeriod } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

export const LIMIT_ERROR_CODES = {
  PER_TX_LIMIT_EXCEEDED: 'LIMIT_PER_TX_EXCEEDED',
  DAILY_LIMIT_EXCEEDED: 'LIMIT_DAILY_EXCEEDED',
} as const;

export type LimitErrorCode = (typeof LIMIT_ERROR_CODES)[keyof typeof LIMIT_ERROR_CODES];

export class LimitExceededException extends HttpException {
  constructor(
    public readonly errorCode: LimitErrorCode,
    message: string,
  ) {
    super({ errorCode, message }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

@Injectable()
export class LimitsService {
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

  async checkLimits(walletId: string, amount: number): Promise<void> {
    const limits = await this.getLimits(walletId);
    if (!limits) return;

    // Enforce per-transaction cap: a cap of 0 blocks all transactions
    if (limits.perTransactionLimit >= 0 && amount > limits.perTransactionLimit) {
      throw new LimitExceededException(
        LIMIT_ERROR_CODES.PER_TX_LIMIT_EXCEEDED,
        `Per-transaction limit exceeded. Limit: ${limits.perTransactionLimit}`,
      );
    }

    // Enforce daily cap only when a positive daily limit is configured
    if (limits.dailyLimit > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const txns = await this.prisma.transaction.findMany({
        where: { senderWalletId: walletId, createdAt: { gte: startOfDay } },
        select: { amount: true },
      });

      const currentDailyTotal = txns.reduce(
        (sum, t) => sum + Number(t.amount),
        0,
      );
      if (currentDailyTotal + amount > limits.dailyLimit) {
        throw new LimitExceededException(
          LIMIT_ERROR_CODES.DAILY_LIMIT_EXCEEDED,
          `Daily limit exceeded. Limit: ${limits.dailyLimit}, Used: ${currentDailyTotal}`,
        );
      }
    }
  }

  async removeLimits(walletId: string) {
    const existing = await this.getLimits(walletId);
    if (!existing) throw new NotFoundException(`No limits found for wallet ${walletId}`);
    return this.prisma.walletLimit.delete({ where: { walletId } });
  }
}
