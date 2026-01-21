import { Injectable } from '@nestjs/common';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LimitsService {
  constructor(private readonly prisma: PrismaService) { }

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
      throw new Error(`Transaction limit exceeded. Limit: ${limits.perTransactionLimit}`);
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const usage = await this.prisma.payment.aggregate({
      where: {
        userId,
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
      throw new Error(`Daily limit exceeded. Limit: ${limits.dailyLimit}, Used: ${currentDailyTotal}`);
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
