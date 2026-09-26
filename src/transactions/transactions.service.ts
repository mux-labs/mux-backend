import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';
import { normalizeMemo } from './transaction-memo';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a PENDING transaction.
   *
   * The memo is validated here — before the insert, not after — so an
   * un-submittable or hostile memo never reaches the database. See
   * `transaction-memo.ts` for the invariants; the short version is that a memo
   * is bounded by Stellar's 28-byte `MemoText` limit, measured in UTF-8 bytes.
   *
   * @throws MemoValidationError when the memo is not admissible. The write is
   *   refused, so a rejected memo never becomes a stored transaction.
   */
  async createTransaction(data: {
    walletId: string;
    amount: string;
    assetCode: string;
    assetType: string;
    status: TransactionStatus;
    memo?: string;
  }) {
    const memo = normalizeMemo(data.memo);

    return this.prisma.transaction.create({
      data: { ...data, memo },
    });
  }
}
