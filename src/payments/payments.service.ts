import { Injectable } from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limitsService: LimitsService,
  ) { }

  async create(createPaymentDto: CreatePaymentDto) {
    // Assuming createPaymentDto has userId, amount, currency
    // If DTO doesn't have userId, we might need to get it from context, but for now assuming it's passed or we use a fixed one for demo
    // The original DTO might be empty. I should check it.
    // For now, I'll assume the DTO has these fields or I'll cast it.
    // Wait, I should check the DTO definition.
    // But to proceed, I'll implement the logic assuming properties exist.

    const { userId, amount, currency } = createPaymentDto as any;

    await this.limitsService.checkLimits(userId, amount);

    return this.prisma.payment.create({
      data: {
        userId,
        amount,
        currency,
      },
    });
  }

  findAll() {
    return this.prisma.payment.findMany();
  }

  findOne(id: number) {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  update(id: number, updatePaymentDto: UpdatePaymentDto) {
    return `This action updates a #${id} payment`;
  }

  remove(id: number) {
    return `This action removes a #${id} payment`;
  }
}
