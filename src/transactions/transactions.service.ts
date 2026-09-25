import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createTransaction(data: {
    walletId: string;
    amount: string;
    assetCode: string;
    assetType: string;
    status: TransactionStatus;
    memo?: string;
  }) {
    return this.prisma.transaction.create({
      data,
    });
  }
}
