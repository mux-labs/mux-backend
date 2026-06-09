import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';
import { WalletsService } from '../wallets/wallets.service';
import { WalletStatus } from '../wallets/domain/wallet.model';
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
    private readonly walletsService: WalletsService,
  ) {}

  async create(createPaymentDto: CreatePaymentDto) {
    const {
      walletId,
      receiverWalletId,
      fromId,
      toId,
      amount,
      currency,
      description,
    } = createPaymentDto;

    const senderWallet = await this.walletsService.findWalletById(walletId);
    if (senderWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException(
        `Sender wallet is not active (status: ${senderWallet.status})`,
      );
    }

    await this.walletsService.findWalletById(receiverWalletId);
    await this.limitsService.checkLimits(walletId, amount);

    return this.prisma.payment.create({
      data: {
        fromId,
        toId,
        amount,
        currency,
        description,
        userId: fromId,
        status: PaymentStatus.PENDING,
      },
    });
  }

  findAll() {
    return this.prisma.payment.findMany();
  }

  findOne(id: string) {
    return this.prisma.payment.findUnique({
      where: { id: parseInt(id, 10) },
    });
  }

  async update(id: string, updatePaymentDto: UpdatePaymentDto) {
    const paymentId = parseInt(id, 10);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) {
      throw new NotFoundException(`Payment #${paymentId} not found`);
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
      where: { id: paymentId },
      data: updatePaymentDto,
    });
  }

  remove(id: string) {
    return `This action removes payment ${id}`;
  }
}
