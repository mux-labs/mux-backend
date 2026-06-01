import { Injectable } from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limitsService: LimitsService,
  ) {}

  async create(createPaymentDto: CreatePaymentDto) {
    const { fromWalletId, toWalletId, amount, currency, description } =
      createPaymentDto;

    await this.limitsService.checkLimits(fromWalletId, amount);

    return this.prisma.transaction.create({
      data: {
        senderWalletId: fromWalletId,
        receiverWalletId: toWalletId,
        amount: String(amount),
        assetType: currency,
        metadata: description ? { description } : undefined,
        status: 'PENDING',
      },
    });
  }

  findAll() {
    return this.prisma.transaction.findMany();
  }

  findOne(id: string) {
    return this.prisma.transaction.findUnique({ where: { id } });
  }

  update(id: string, _dto: any) {
    return `This action updates payment ${id}`;
  }

  remove(id: string) {
    return `This action removes payment ${id}`;
  }
}
