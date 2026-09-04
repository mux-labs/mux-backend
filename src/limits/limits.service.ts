import {
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { CreateLimitDto, LimitPeriod } from './dto/create-limit.dto';
import { LimitUpdatedEvent } from './events/limit-updated.event';
import { LimitExceededEvent } from './events/limit-exceeded.event';
import { LimitWarningEvent } from './events/limit-warning.event';
import { LimitsResponseDto } from './dto/limits-response.dto';
import { retryWithBackoff } from '../common/utils/retry';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';

/** Emit a warning once spending reaches this fraction of a limit, without blocking */
const WARNING_THRESHOLD_RATIO = 0.8;

export const LIMIT_ERROR_CODES = {
  PER_TX_LIMIT_EXCEEDED: 'LIMIT_PER_TX_EXCEEDED',
  DAILY_LIMIT_EXCEEDED: 'LIMIT_DAILY_EXCEEDED',
} as const;

export type LimitErrorCode =
  (typeof LIMIT_ERROR_CODES)[keyof typeof LIMIT_ERROR_CODES];

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
  private readonly logger = new Logger(LimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
  ) {}

  private async getDailyUsageTotal(
    walletId: string,
    startOfDay: Date,
  ): Promise<number> {
    const txns = await retryWithBackoff(
      () =>
        this.prisma.transaction.findMany({
          where: { senderWalletId: walletId, createdAt: { gte: startOfDay } },
          select: { amount: true },
        }),
      3,
      100,
      this.logger,
    );

    const paymentRows = this.prisma.payment?.findMany
      ? await retryWithBackoff(
          () =>
            this.prisma.payment.findMany({
              where: { createdAt: { gte: startOfDay } },
              select: { amount: true },
            }),
          3,
          100,
          this.logger,
        )
      : [];

    return (
      txns.reduce((sum, t) => sum + Number(t.amount || 0), 0) +
      paymentRows.reduce((sum, p) => sum + Number(p.amount || 0), 0)
    );
  }

  async setLimits(walletId: string, daily: number, perTx: number) {
    // Read-then-write is wrapped in a single Prisma transaction so a
    // concurrent setLimits call for the same wallet can't interleave
    // between the existence check and the upsert, which would otherwise
    // produce incorrect limit.updated diffs (comparing against stale data).
    const { existing, result } = await retryWithBackoff(
      () =>
        this.prisma.$transaction(async (tx) => {
          const existing = await tx.walletLimit.findUnique({
            where: { walletId },
          });

          const result = await tx.walletLimit.upsert({
            where: { walletId },
            update: {
              dailyLimit: daily,
              perTransactionLimit: perTx,
              deletedAt: null,
            },
            create: { walletId, dailyLimit: daily, perTransactionLimit: perTx },
          });

          return { existing, result };
        }),
      3,
      100,
      this.logger,
    );

    if (existing) {
      if (existing.dailyLimit !== daily) {
        this.eventEmitter.emit(
          'limit.updated',
          new LimitUpdatedEvent(
            walletId,
            'daily',
            existing.dailyLimit,
            daily,
            new Date(),
          ),
        );
      }
      if (existing.perTransactionLimit !== perTx) {
        this.eventEmitter.emit(
          'limit.updated',
          new LimitUpdatedEvent(
            walletId,
            'perTransaction',
            existing.perTransactionLimit,
            perTx,
            new Date(),
          ),
        );
      }
    } else {
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(walletId, 'daily', null, daily, new Date()),
      );
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(
          walletId,
          'perTransaction',
          null,
          perTx,
          new Date(),
        ),
      );
    }

    return result;
  }

  async getLimits(walletId: string): Promise<LimitsResponseDto | null> {
    const limit = await retryWithBackoff(
      () =>
        this.prisma.walletLimit.findUnique({
          where: { walletId },
        }),
      3,
      100,
      this.logger,
    );

    if (!limit) {
      return null;
    }

    const response: LimitsResponseDto = {
      walletId: limit.walletId,
      dailyLimit: limit.dailyLimit,
      perTransactionLimit: limit.perTransactionLimit,
    };

    // Calculate remaining daily limit if a positive daily limit is configured.
    // Daily usage includes both wallet transactions and payment rows created by the payments API.
    if (limit.dailyLimit > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const currentDailyTotal = await this.getDailyUsageTotal(walletId, startOfDay);
      response.remainingDailyLimit = Math.max(
        0,
        limit.dailyLimit - currentDailyTotal,
      );
    }

    return response;
  }

  async checkLimits(
    walletId: string,
    amount: number,
    assetCode?: string,
  ): Promise<void> {
    const limits = await this.getLimits(walletId);

    if (limits) {
      this.logger.log(`Checking limits walletId=${walletId} amount=${amount}`);

      // Enforce per-transaction cap: a cap of 0 blocks all transactions
      if (
        limits.perTransactionLimit >= 0 &&
        amount > limits.perTransactionLimit
      ) {
        this.eventEmitter.emit(
          'limit.exceeded',
          new LimitExceededEvent(
            walletId,
            'perTransaction',
            limits.perTransactionLimit,
            amount,
            new Date(),
          ),
        );
        throw new LimitExceededException(
          LIMIT_ERROR_CODES.PER_TX_LIMIT_EXCEEDED,
          `Per-transaction limit exceeded. Limit: ${limits.perTransactionLimit}`,
        );
      }

      // Enforce daily cap only when a positive daily limit is configured
      if (limits.dailyLimit > 0) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const txns = await retryWithBackoff(
          () =>
            this.prisma.transaction.findMany({
              where: {
                senderWalletId: walletId,
                createdAt: { gte: startOfDay },
              },
              select: { amount: true },
            }),
          3,
          100,
          this.logger,
        );

        const currentDailyTotal = txns.reduce(
          (sum, t) => sum + Number(t.amount),
          0,
        );
        if (currentDailyTotal + amount > limits.dailyLimit) {
          this.metrics.incrementLimitExceeded('daily');
          this.metrics.incrementLimitChecks('denied');
          this.eventEmitter.emit(
            'limit.exceeded',
            new LimitExceededEvent(
              walletId,
              'daily',
              limits.dailyLimit,
              currentDailyTotal + amount,
              new Date(),
            ),
          );
          throw new LimitExceededException(
            LIMIT_ERROR_CODES.DAILY_LIMIT_EXCEEDED,
            `Daily limit exceeded. Limit: ${limits.dailyLimit}, Used: ${currentDailyTotal}`,
          );
        }
      }
    }

    // Enforce per-asset spending limits (SpendingLimit) in addition to wallet floats
    await this.enforceSpendingLimits(walletId, amount, assetCode);

    this.metrics.incrementLimitChecks('allowed');
  }

  /**
   * Enforces per-asset spending limits for the wallet's owner.
   * SpendingLimit rows are scoped by userId + assetCode (+ period), so native XLM
   * (assetCode null) and non-native assets such as USDC are accounted separately.
   */
  private async enforceSpendingLimits(
    walletId: string,
    amount: number,
    assetCode?: string,
  ): Promise<void> {
    const wallet = await retryWithBackoff(
      () =>
        this.prisma.wallet.findUnique({
          where: { id: walletId },
          select: { userId: true },
        }),
      3,
      100,
      this.logger,
    );

    if (!wallet) {
      return;
    }

    if (
      limits.perTransactionLimit > 0 &&
      amount >= limits.perTransactionLimit * WARNING_THRESHOLD_RATIO
    ) {
      this.logger.warn(
        `Wallet ${walletId} nearing per-transaction limit: amount=${amount} limit=${limits.perTransactionLimit}`,
      );
      this.eventEmitter.emit(
        'limit.warning',
        new LimitWarningEvent(
          walletId,
          'perTransaction',
          limits.perTransactionLimit,
          amount,
          new Date(),
        ),
      );
    }

    // Enforce daily cap only when a positive daily limit is configured.
    // Total usage includes wallet transactions and payment API rows created today.
    if (limits.dailyLimit > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const currentDailyTotal = await this.getDailyUsageTotal(walletId, startOfDay);
      if (currentDailyTotal + amount > limits.dailyLimit) {
        this.metrics.incrementLimitExceeded('daily');
        this.metrics.incrementLimitChecks('denied');
        this.eventEmitter.emit(
          'limit.exceeded',
          new LimitExceededEvent(
            walletId,
            'period',
            periodLimit,
            currentPeriodTotal + amount,
            new Date(),
          ),
        );
        throw new LimitExceededException(
          LIMIT_ERROR_CODES.DAILY_LIMIT_EXCEEDED,
          `Period limit exceeded for asset. Limit: ${periodLimit}, Used: ${currentPeriodTotal}`,
        );
      }

      if (
        currentDailyTotal + amount >=
        limits.dailyLimit * WARNING_THRESHOLD_RATIO
      ) {
        this.logger.warn(
          `Wallet ${walletId} nearing daily limit: projected=${currentDailyTotal + amount} limit=${limits.dailyLimit}`,
        );
        this.eventEmitter.emit(
          'limit.warning',
          new LimitWarningEvent(
            walletId,
            'daily',
            limits.dailyLimit,
            currentDailyTotal + amount,
            new Date(),
          ),
        );
      }
    }
  }

  /**
   * Returns the start of the current period for a given limit period.
   */
  private getPeriodStart(period: LimitPeriod): Date {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    if (period === LimitPeriod.WEEKLY) {
      // Monday-based week
      const daysSinceMonday = (now.getDay() + 6) % 7;
      now.setDate(now.getDate() - daysSinceMonday);
    } else if (period === LimitPeriod.MONTHLY) {
      now.setDate(1);
    }

    return now;
  }

  /**
   * Creates or updates a per-asset spending limit for a user.
   * assetCode null applies the limit across all assets (e.g. native XLM).
   */
  async setSpendingLimit(dto: CreateLimitDto) {
    const period = dto.period ?? LimitPeriod.DAILY;
    const assetCode = dto.assetCode ?? null;

    const data = {
      perTransactionLimit: dto.perTransactionLimit,
      periodLimit: dto.periodLimit,
      isActive: dto.isActive ?? true,
    };

    const existing = await retryWithBackoff(
      () =>
        this.prisma.spendingLimit.findFirst({
          where: { userId: dto.userId, period, assetCode },
        }),
      3,
      100,
      this.logger,
    );

    const result = existing
      ? await this.prisma.spendingLimit.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.spendingLimit.create({
          data: { ...data, userId: dto.userId, period, assetCode },
        });

    this.logger.log(
      `Set spending limit for user ${dto.userId} period=${period} asset=${assetCode ?? 'ALL'}`,
    );

    return result;
  }

  /**
   * Lists the per-asset spending limits configured for a user.
   */
  async getSpendingLimits(
    userId: string,
    filter?: { period?: LimitPeriod; isActive?: boolean },
  ) {
    return retryWithBackoff(
      () =>
        this.prisma.spendingLimit.findMany({
          where: {
            userId,
            ...(filter?.period ? { period: filter.period } : {}),
            ...(filter?.isActive !== undefined
              ? { isActive: filter.isActive }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
        }),
      3,
      100,
      this.logger,
    );
  }

  /**
   * Deactivates a per-asset spending limit for a user (period + asset).
   */
  async removeSpendingLimit(
    userId: string,
    period: LimitPeriod,
    assetCode?: string,
  ) {
    return retryWithBackoff(
      () =>
        this.prisma.spendingLimit.updateMany({
          where: {
            userId,
            period,
            assetCode: assetCode ?? null,
          },
          data: { isActive: false },
        }),
      3,
      100,
      this.logger,
    );
  }

  async removeLimits(walletId: string) {
    const existing = await this.getLimits(walletId);
    if (!existing)
      throw new NotFoundException(`No limits found for wallet ${walletId}`);
    return retryWithBackoff(
      () =>
        this.prisma.walletLimit.update({
          where: { walletId },
          data: { deletedAt: new Date() },
        }),
      3,
      100,
      this.logger,
    );
  }

  async updateLimits(walletId: string, daily?: number, perTx?: number) {
    const existing = await this.getLimits(walletId);
    if (!existing)
      throw new NotFoundException(`No limits found for wallet ${walletId}`);

    if (daily === undefined && perTx === undefined) {
      return existing;
    }

    const updateData: {
      dailyLimit?: number;
      perTransactionLimit?: number;
    } = {};
    if (daily !== undefined) updateData.dailyLimit = daily;
    if (perTx !== undefined) updateData.perTransactionLimit = perTx;

    const result = await retryWithBackoff(
      () =>
        this.prisma.walletLimit.update({
          where: { walletId },
          data: updateData,
        }),
      3,
      100,
      this.logger,
    );

    if (daily !== undefined && existing.dailyLimit !== daily) {
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(
          walletId,
          'daily',
          existing.dailyLimit,
          daily,
          new Date(),
        ),
      );
    }
    if (perTx !== undefined && existing.perTransactionLimit !== perTx) {
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(
          walletId,
          'perTransaction',
          existing.perTransactionLimit,
          perTx,
          new Date(),
        ),
      );
    }

    return result;
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
