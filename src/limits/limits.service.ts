import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { CreateLimitDto, LimitPeriod } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly webhookEmitter?: WebhookEventEmitterService,
  ) {}

  async setLimits(walletId: string, daily: number, perTx: number) {
    const existing = await this.prisma.walletLimit.findUnique({
      where: { walletId },
    });

    const result = await this.prisma.walletLimit.upsert({
      where: { walletId },
      update: { dailyLimit: daily, perTransactionLimit: perTx },
      create: { walletId, dailyLimit: daily, perTransactionLimit: perTx },
    });

    // Emit webhook events for limit changes
    if (!existing || existing.dailyLimit !== daily) {
      this.emitLimitUpdatedSafe(walletId, 'daily', existing?.dailyLimit ?? null, daily);
    }
    if (!existing || existing.perTransactionLimit !== perTx) {
      this.emitLimitUpdatedSafe(walletId, 'perTransaction', existing?.perTransactionLimit ?? null, perTx);
    }

    return result;
  }

  async getLimits(walletId: string) {
    return this.prisma.walletLimit.findUnique({ where: { walletId } });
  }

  async checkLimits(walletId: string, amount: number): Promise<void> {
    const limits = await this.getLimits(walletId);
    if (!limits) return;

    if (amount > limits.perTransactionLimit) {
      this.emitLimitExceededSafe(walletId, 'perTransaction', limits.perTransactionLimit, amount);
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

    // Emit warning when approaching 80% of daily limit
    if (
      limits.dailyLimit > 0 &&
      currentDailyTotal + amount >= limits.dailyLimit * 0.8
    ) {
      this.emitLimitWarningSafe(walletId, 'daily', limits.dailyLimit, currentDailyTotal + amount);
    }

    if (currentDailyTotal + amount > limits.dailyLimit) {
      this.emitLimitExceededSafe(walletId, 'daily', limits.dailyLimit, currentDailyTotal + amount);
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

  private emitLimitUpdatedSafe(
    walletId: string,
    limitType: string,
    oldValue: number | null,
    newValue: number,
  ): void {
    this.webhookEmitter
      ?.emitLimitUpdated({ walletId, limitType, oldValue, newValue })
      .catch((err) => {
        this.logger.error(
          `Failed to dispatch limit.updated webhook for wallet ${walletId}: ${(err as Error).message}`,
        );
      });
  }

  private emitLimitExceededSafe(
    walletId: string,
    limitType: string,
    limit: number,
    attempted: number,
  ): void {
    this.webhookEmitter
      ?.emitLimitExceeded({ walletId, limitType, limit, attempted })
      .catch((err) => {
        this.logger.error(
          `Failed to dispatch limit.exceeded webhook for wallet ${walletId}: ${(err as Error).message}`,
        );
      });
  }

  private emitLimitWarningSafe(
    walletId: string,
    limitType: string,
    limit: number,
    projected: number,
  ): void {
    this.webhookEmitter
      ?.emitLimitWarning({ walletId, limitType, limit, projected })
      .catch((err) => {
        this.logger.error(
          `Failed to dispatch limit.warning webhook for wallet ${walletId}: ${(err as Error).message}`,
        );
      });
  }
}
