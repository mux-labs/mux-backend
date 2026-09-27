import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';

@Injectable()
export class TransactionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters: {
    walletId?: string;
    senderWalletId?: string;
    limit?: number;
    offset?: number;
  }) {
    return this.prisma.transaction.findMany({
      where: {
        walletId: filters.walletId,
        senderWalletId: filters.senderWalletId,
      },
      take: filters.limit,
      skip: filters.offset,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return this.prisma.transaction.findUnique({
      where: { id },
    });
  }
}
