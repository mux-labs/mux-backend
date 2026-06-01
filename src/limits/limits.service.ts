import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLimitDto, LimitPeriod } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

@Injectable()
export class LimitsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLimitDto) {
    const { userId, perTransactionLimit, periodLimit, period, assetCode, isActive } = dto;

    // Verify user exists
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    try {
      return await this.prisma.spendingLimit.create({
        data: {
          userId,
          perTransactionLimit,
          periodLimit,
          period: period ?? LimitPeriod.DAILY,
          assetCode: assetCode ?? null,
          isActive: isActive ?? true,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          'A spending limit for this user, period, and asset already exists',
        );
      }
      throw err;
    }
  }

  findAll() {
    return this.prisma.spendingLimit.findMany();
  }

  async findByUser(userId: string) {
    return this.prisma.spendingLimit.findMany({ where: { userId } });
  }

  async findOne(id: string) {
    const limit = await this.prisma.spendingLimit.findUnique({ where: { id } });
    if (!limit) throw new NotFoundException(`SpendingLimit ${id} not found`);
    return limit;
  }

  async update(id: string, dto: UpdateLimitDto) {
    await this.findOne(id); // throws if not found
    return this.prisma.spendingLimit.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOne(id); // throws if not found
    return this.prisma.spendingLimit.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Legacy helpers (used by PaymentsService via LegacyUser / UserLimit model)
  // ---------------------------------------------------------------------------

  async setLimits(userId: number, daily: number, perTx: number) {
    return this.prisma.userLimit.upsert({
      where: { userId },
      update: { dailyLimit: daily, perTransactionLimit: perTx },
      create: { userId, dailyLimit: daily, perTransactionLimit: perTx },
    });
  }

  async getLimits(userId: number) {
    return this.prisma.userLimit.findUnique({ where: { userId } });
  }

  async checkLimits(userId: number, amount: number): Promise<void> {
    const limits = await this.getLimits(userId);
    if (!limits) return;

    if (amount > limits.perTransactionLimit) {
      throw new Error(
        `Transaction limit exceeded. Limit: ${limits.perTransactionLimit}`,
      );
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const usage = await this.prisma.payment.aggregate({
      where: { fromId: userId, createdAt: { gte: startOfDay } },
      _sum: { amount: true },
    });

    const currentDailyTotal = usage._sum.amount ?? 0;
    if (currentDailyTotal + amount > limits.dailyLimit) {
      throw new Error(
        `Daily limit exceeded. Limit: ${limits.dailyLimit}, Used: ${currentDailyTotal}`,
      );
    }
  }
}
