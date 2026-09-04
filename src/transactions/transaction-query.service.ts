import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';
import { Transaction as TransactionEntity } from './entities/transaction.entity';
import { CacheService } from '../common/cache/cache.service';
import { PaginatedTransactionsDto } from './dto/paginated-transactions.dto';

/**
 * Extended filter options for querying transactions.
 *
 * #497: Added assetType, assetCode, minAmount, maxAmount, createdAfter, createdBefore
 * to the existing senderWalletId / receiverWalletId / status / memo filters.
 */
export interface TransactionFilters {
  senderWalletId?: string;
  receiverWalletId?: string;
  status?: TransactionStatus;
  /** Filter by asset type (e.g. "NATIVE", "CREDIT_ALPHANUM4"). */
  assetType?: string;
  /** Filter by asset code (e.g. "USDC"). */
  assetCode?: string;
  /** Minimum amount (inclusive, stored as string for precision). */
  minAmount?: string;
  /** Maximum amount (inclusive, stored as string for precision). */
  maxAmount?: string;
  /** Return only transactions created on or after this date. */
  createdAfter?: Date;
  /** Return only transactions created on or before this date. */
  createdBefore?: Date;
  memo?: string;
  limit?: number;
  offset?: number;
}

export interface TransactionPagination {
  limit?: number;
  offset?: number;
}

@Injectable()
export class TransactionQueryService {
  private readonly logger = new Logger(TransactionQueryService.name);
  private readonly TRANSACTION_CACHE_TTL = 300000; // 5 minutes
  static readonly CACHE_KEY_PREFIX = 'transaction';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Find all transactions matching the given filters, ordered newest-first.
   * Returns a paginated envelope with total count and hasMore flag.
   */
  async findAll(filters?: TransactionFilters): Promise<PaginatedTransactionsDto> {
    const where: any = {};

    if (filters?.senderWalletId) {
      where.senderWalletId = filters.senderWalletId;
    }

    if (filters?.receiverWalletId) {
      where.receiverWalletId = filters.receiverWalletId;
    }

    if (filters?.status) {
      where.status = filters.status;
    }

    // #497: asset-type and asset-code filters
    if (filters?.assetType) {
      where.assetType = filters.assetType;
    }

    if (filters?.assetCode) {
      where.assetCode = filters.assetCode;
    }

    // #497: amount range filter
    if (filters?.minAmount !== undefined || filters?.maxAmount !== undefined) {
      where.amount = {};
      if (filters.minAmount !== undefined) {
        where.amount.gte = filters.minAmount;
      }
      if (filters.maxAmount !== undefined) {
        where.amount.lte = filters.maxAmount;
      }
    }

    // #497: date range filter
    if (filters?.createdAfter !== undefined || filters?.createdBefore !== undefined) {
      where.createdAt = {};
      if (filters.createdAfter !== undefined) {
        where.createdAt.gte = filters.createdAfter;
      }
      if (filters.createdBefore !== undefined) {
        where.createdAt.lte = filters.createdBefore;
      }
    }

    if (filters?.memo) {
      where.memo = { contains: filters.memo, mode: 'insensitive' };
    }

    const limit = filters?.limit ?? 20;
    const offset = filters?.offset ?? 0;

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      data: transactions.map((t) => this.mapPrismaToEntity(t)),
      total,
      limit,
      offset,
      hasMore: offset + transactions.length < total,
    };
  }

  async findOne(id: string): Promise<TransactionEntity> {
    const cacheKey = `${TransactionQueryService.CACHE_KEY_PREFIX}:${id}`;

    const cached = this.cache.get<TransactionEntity>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for transaction ${id}`);
      return cached;
    }

    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    const entity = this.mapPrismaToEntity(transaction);
    this.cache.set(cacheKey, entity, this.TRANSACTION_CACHE_TTL);

    return entity;
  }

  async findByWallet(
    walletId: string,
    pagination?: TransactionPagination,
  ): Promise<TransactionEntity[]> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const transactions = await this.prisma.transaction.findMany({
      where: {
        OR: [{ senderWalletId: walletId }, { receiverWalletId: walletId }],
      },
      orderBy: { createdAt: 'desc' },
      take: pagination?.limit,
      skip: pagination?.offset,
    });

    return transactions.map((t) => this.mapPrismaToEntity(t));
  }

  async findByStellarHash(hash: string): Promise<TransactionEntity | null> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { stellarHash: hash },
    });

    return transaction ? this.mapPrismaToEntity(transaction) : null;
  }

  /**
   * Find transactions stuck in PENDING status for longer than the specified threshold.
   * Returns paginated results, sorted by createdAt ascending (oldest first).
   */
  async findStuckPendingTransactions(
    thresholdMinutes: number = 60,
    limit: number = 100,
    offset: number = 0,
  ): Promise<{ data: TransactionEntity[]; total: number }> {
    const thresholdDate = new Date(Date.now() - thresholdMinutes * 60 * 1000);

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: {
          status: TransactionStatus.PENDING,
          createdAt: { lt: thresholdDate },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.transaction.count({
        where: {
          status: TransactionStatus.PENDING,
          createdAt: { lt: thresholdDate },
        },
      }),
    ]);

    return {
      data: transactions.map((t) => this.mapPrismaToEntity(t)),
      total,
    };
  }

  invalidateCache(id: string): void {
    this.cache.delete(`${TransactionQueryService.CACHE_KEY_PREFIX}:${id}`);
  }

  private mapPrismaToEntity(prismaTransaction: any): TransactionEntity {
    return {
      id: prismaTransaction.id,
      amount: prismaTransaction.amount,
      assetType: prismaTransaction.assetType,
      assetCode: prismaTransaction.assetCode,
      assetIssuer: prismaTransaction.assetIssuer,
      senderWalletId: prismaTransaction.senderWalletId,
      receiverWalletId: prismaTransaction.receiverWalletId,
      memo: prismaTransaction.memo,
      status: prismaTransaction.status as TransactionStatus,
      stellarHash: prismaTransaction.stellarHash,
      stellarLedger: prismaTransaction.stellarLedger,
      stellarFee: prismaTransaction.stellarFee,
      statusChangedAt: prismaTransaction.statusChangedAt,
      statusReason: prismaTransaction.statusReason,
      submittedAt: prismaTransaction.submittedAt,
      confirmedAt: prismaTransaction.confirmedAt,
      failedAt: prismaTransaction.failedAt,
      metadata: prismaTransaction.metadata,
      idempotencyKey: prismaTransaction.idempotencyKey,
      createdAt: prismaTransaction.createdAt,
      updatedAt: prismaTransaction.updatedAt,
    };
  }
}
