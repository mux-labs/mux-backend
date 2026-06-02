import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

    if (amount > limits.perTransactionLimit) {
      throw new Error(
        `Transaction limit exceeded. Limit: ${limits.perTransactionLimit}`,
      );
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const txns = await this.prisma.transaction.findMany({
      where: { senderWalletId: walletId, createdAt: { gte: startOfDay } },
      select: { amount: true },
    });

    const currentDailyTotal = txns.reduce((sum, t) => sum + Number(t.amount), 0);
    if (currentDailyTotal + amount > limits.dailyLimit) {
      throw new Error(
        `Daily limit exceeded. Limit: ${limits.dailyLimit}, Used: ${currentDailyTotal}`,
      );
    }
  }

  async removeLimits(walletId: string) {
    const existing = await this.getLimits(walletId);
    if (!existing) throw new NotFoundException(`No limits found for wallet ${walletId}`);
    return this.prisma.walletLimit.delete({ where: { walletId } });
  }
}
