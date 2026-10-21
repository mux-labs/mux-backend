import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';

@Injectable()
export class TransactionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filters: {
    walletId?: string;
    senderWalletId?: string;
    status?: TransactionStatus;
    cursor?: string;
    limit?: number;
    offset?: number;
  }) {
    if (filters.cursor !== undefined && filters.offset !== undefined) {
      throw new BadRequestException(
        'cursor and offset are mutually exclusive',
      );
    }

    const pageSize = Math.min(filters.limit ?? 20, 100);

    // Fetch one extra row to detect whether another page exists
    const transactions = await this.prisma.transaction.findMany({
      where: {
        walletId: filters.walletId,
        senderWalletId: filters.senderWalletId,
        status: filters.status,
      },
      take: pageSize + 1,
      ...(filters.cursor
        ? { cursor: { id: filters.cursor }, skip: 1 }
        : { skip: filters.offset }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const hasMore = transactions.length > pageSize;
    const data = transactions.slice(0, pageSize);
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data, nextCursor, hasMore };
  }

  async findById(id: string) {
    return this.prisma.transaction.findUnique({
      where: { id },
    });
  }
}
