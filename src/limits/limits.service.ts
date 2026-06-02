import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { PrismaService } from '../prisma/prisma.service';

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

  async setLimits(userId: number, daily: number, perTx: number) {
    return this.prisma.userLimit.upsert({
      where: { userId },
      update: { dailyLimit: daily, perTransactionLimit: perTx },
      create: { userId, dailyLimit: daily, perTransactionLimit: perTx },
    });
  }

  async getLimits(userId: number) {
    return this.prisma.userLimit.findUnique({
      where: { userId },
    });
  }

  async checkLimits(userId: number, amount: number): Promise<void> {
    const limits = await this.getLimits(userId);
    if (!limits) return; // No limits set

    if (amount > limits.perTransactionLimit) {
      throw new LimitExceededException(
        LIMIT_ERROR_CODES.PER_TX_LIMIT_EXCEEDED,
        `Per-transaction limit exceeded. Limit: ${limits.perTransactionLimit}`,
      );
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const usage = await this.prisma.payment.aggregate({
      where: {
        fromId: userId,
        createdAt: {
          gte: startOfDay,
        },
      },
      _sum: {
        amount: true,
      },
    });

    const currentDailyTotal = usage._sum.amount || 0;
    if (currentDailyTotal + amount > limits.dailyLimit) {
      throw new LimitExceededException(
        LIMIT_ERROR_CODES.DAILY_LIMIT_EXCEEDED,
        `Daily limit exceeded. Limit: ${limits.dailyLimit}, Used: ${currentDailyTotal}`,
      );
    }
  }

  create(createLimitDto: CreateLimitDto) {
    return 'This action adds a new limit';
  }

  findAll() {
    return `This action returns all limits`;
  }

  findOne(id: number) {
    return `This action returns a #${id} limit`;
  }

  update(id: number, updateLimitDto: UpdateLimitDto) {
    return `This action updates a #${id} limit`;
  }

  remove(id: number) {
    return `This action removes a #${id} limit`;
  }
}
