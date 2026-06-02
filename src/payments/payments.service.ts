import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';
import { PaymentStatus } from './entities/payment.entity';

// Only PENDING payments can be transitioned; terminal states are immutable.
const ALLOWED_TRANSITIONS: Record<string, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limitsService: LimitsService,
  ) {}

  async create(createPaymentDto: CreatePaymentDto) {
    const { fromId, toId, amount, currency, description } = createPaymentDto;

    await this.limitsService.checkLimits(fromId, amount);

    return this.prisma.payment.create({
      data: {
        fromId,
        toId,
        amount,
        currency,
        description,
        userId: fromId, // Legacy support: default to sender
        status: 'PENDING',
      },
    });
  }

  findAll() {
    return this.prisma.payment.findMany();
  }

  findOne(id: number) {
    return this.prisma.payment.findUnique({ where: { id } });
  }

  async update(id: number, updatePaymentDto: UpdatePaymentDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) {
      throw new NotFoundException(`Payment #${id} not found`);
    }

    if (updatePaymentDto.status !== undefined) {
      const allowed = ALLOWED_TRANSITIONS[payment.status] ?? [];
      if (!allowed.includes(updatePaymentDto.status)) {
        throw new BadRequestException(
          `Cannot transition payment from ${payment.status} to ${updatePaymentDto.status}`,
        );
      }
    }

    return this.prisma.payment.update({
      where: { id },
      data: updatePaymentDto,
    });
  }

  remove(id: number) {
    return `This action removes a #${id} payment`;
  }
}
