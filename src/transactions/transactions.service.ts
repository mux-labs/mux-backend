import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { BalanceIndexerService } from '../balance-indexer/balance-indexer.service';
import { Asset } from '../balance-indexer/domain/balance.model';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionStatusDto } from './dto/update-transaction.dto';
import {
  TransactionStatus,
  canTransitionTransactionStatus,
} from './domain/transaction.model';
import { Transaction as TransactionEntity } from './entities/transaction.entity';
import { validateMemo } from '../common/stellar/memo.util';
import { PaginatedTransactionsDto } from './dto/paginated-transactions.dto';
import { InsufficientBalanceException } from './domain/insufficient-balance.exception';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { CacheService } from '../common/cache/cache.service';
import { TransactionMetricsService } from './transaction-metrics.service';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);
  private readonly TRANSACTION_CACHE_TTL = 300000; // 5 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceIndexer: BalanceIndexerService,
    private readonly cache: CacheService,
    @Optional()
    private readonly webhookEventEmitter?: WebhookEventEmitterService,
    @Optional()
    private readonly metrics?: TransactionMetricsService,
  ) {}

  /**
   * Create a new transaction in PENDING state.
   * If an idempotencyKey is supplied and a transaction with that key already
   * exists, the existing transaction is returned without creating a duplicate.
   */
  async create(createTransactionDto: CreateTransactionDto): Promise<TransactionEntity> {
    const {
      amount,
      asset,
      senderWalletId,
      receiverWalletId,
      memo,
      metadata,
      idempotencyKey,
    } = createTransactionDto;

    // Validate memo length/type against Stellar protocol constraints before touching persistence
    validateMemo(memo);

    // Idempotency check: return existing transaction if key already used
    if (idempotencyKey) {
      const existing = await this.prisma.transaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.log(
          `Idempotency hit for key ${idempotencyKey}, returning existing transaction ${existing.id}`,
        );
        this.metrics?.incrementIdempotencyHit();
        const entity = this.mapPrismaToEntity(existing);
        (entity as any)._idempotencyKey = idempotencyKey;
        (entity as any)._isReplay = true;
        (entity as any)._createdAt = existing.createdAt;
        return entity;
      }
    }

    // Validate wallets exist
    const senderWallet = await this.prisma.wallet.findUnique({
      where: { id: senderWalletId },
    });

    if (!senderWallet) {
      throw new NotFoundException(`Sender wallet ${senderWalletId} not found`);
    }

    if (receiverWalletId) {
      const receiverWallet = await this.prisma.wallet.findUnique({
        where: { id: receiverWalletId },
      });

      if (!receiverWallet) {
        throw new NotFoundException(
          `Receiver wallet ${receiverWalletId} not found`,
        );
      }
    }

    // Check sender has sufficient balance
    const balanceAsset: Asset = {
      type: asset.type as any,
      code: asset.code ?? undefined,
      issuer: asset.issuer ?? undefined,
    };
    const walletBalance = await this.balanceIndexer.getBalance(
      senderWalletId,
      balanceAsset,
    );
    const available = walletBalance?.balance ?? '0';
    if (parseFloat(available) < parseFloat(amount)) {
      throw new InsufficientBalanceException(
        senderWalletId,
        amount,
        available,
        asset.code,
      );
    }

    // Create transaction in database
    const created = await this.prisma.transaction.create({
      data: {
        amount,
        assetType: asset.type,
        assetCode: asset.code ?? null,
        assetIssuer: asset.issuer ?? null,
        senderWalletId,
        receiverWalletId: receiverWalletId ?? null,
        memo: memo ?? null,
        status: TransactionStatus.PENDING,
        metadata: metadata ?? undefined,
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    this.metrics?.incrementTransactionCreated(asset.type);

    this.emitDomainEvent('transaction.created', () =>
      this.webhookEventEmitter?.emitTransactionCreated({
        transactionId: created.id,
        walletId: created.senderWalletId,
        amount: created.amount,
        asset: created.assetCode ?? created.assetType,
        destination: created.receiverWalletId ?? '',
      }),
    );

    const entity = this.mapPrismaToEntity(created);
    if (idempotencyKey) {
      (entity as any)._idempotencyKey = idempotencyKey;
      (entity as any)._isReplay = false;
      (entity as any)._createdAt = created.createdAt;
    }
    return entity;
  }

  /**
   * Find all transactions with optional filters, returns paginated response
   */
  async findAll(filters?: {
    senderWalletId?: string;
    receiverWalletId?: string;
    status?: TransactionStatus;
    assetType?: string;
    assetCode?: string;
    minAmount?: string;
    maxAmount?: string;
    createdAfter?: Date;
    createdBefore?: Date;
    memo?: string;
    limit?: number;
    offset?: number;
  }): Promise<PaginatedTransactionsDto> {
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

    if (filters?.assetType) {
      where.assetType = filters.assetType;
    }

    if (filters?.assetCode) {
      where.assetCode = filters.assetCode;
    }

    if (filters?.memo) {
      where.memo = { contains: filters.memo, mode: 'insensitive' };
    }

    if (filters?.minAmount !== undefined || filters?.maxAmount !== undefined) {
      where.amount = {};
      if (filters.minAmount !== undefined) {
        where.amount.gte = filters.minAmount;
      }
      if (filters.maxAmount !== undefined) {
        where.amount.lte = filters.maxAmount;
      }
    }

    if (filters?.createdAfter !== undefined || filters?.createdBefore !== undefined) {
      where.createdAt = {};
      if (filters.createdAfter !== undefined) {
        where.createdAt.gte = filters.createdAfter;
      }
      if (filters.createdBefore !== undefined) {
        where.createdAt.lte = filters.createdBefore;
      }
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

  /**
   * Find a transaction by ID with caching
   */
  async findOne(id: string): Promise<TransactionEntity> {
    const cacheKey = `transaction:${id}`;

    const cachedTransaction = this.cache.get<TransactionEntity>(cacheKey);
    if (cachedTransaction) {
      this.logger.debug(`Cache hit for transaction ${id}`);
      this.metrics?.incrementCacheHit();
      return cachedTransaction;
    }
    this.metrics?.incrementCacheMiss();

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

  /**
   * Update transaction status with proper state transition validation
   */
  async updateStatus(
    id: string,
    updateDto: UpdateTransactionStatusDto,
  ): Promise<TransactionEntity> {
    const existing = await this.prisma.transaction.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    if (
      !canTransitionTransactionStatus(
        existing.status as TransactionStatus,
        updateDto.status,
      )
    ) {
      throw new BadRequestException(
        `Invalid status transition: ${existing.status} -> ${updateDto.status}`,
      );
    }

    const updateData: any = {
      status: updateDto.status,
      statusChangedAt: new Date(),
      updatedAt: new Date(),
    };

    if (updateDto.status === TransactionStatus.SUBMITTED) {
      updateData.submittedAt = new Date();
    } else if (updateDto.status === TransactionStatus.CONFIRMED) {
      updateData.confirmedAt = new Date();
    } else if (updateDto.status === TransactionStatus.FAILED) {
      updateData.failedAt = new Date();
    }

    if (updateDto.statusReason !== undefined) {
      updateData.statusReason = updateDto.statusReason;
    }

    if (updateDto.stellarHash !== undefined) {
      updateData.stellarHash = updateDto.stellarHash;
    }
    if (updateDto.stellarLedger !== undefined) {
      updateData.stellarLedger = updateDto.stellarLedger;
    }
    if (updateDto.stellarFee !== undefined) {
      updateData.stellarFee = updateDto.stellarFee;
    }

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: updateData,
    });

    this.cache.delete(`transaction:${id}`);

    this.metrics?.incrementStatusUpdated(existing.status, updateDto.status);

    this.logger.log(
      `Updated transaction ${id} status: ${existing.status} -> ${updateDto.status}`,
    );

    this.emitStatusDomainEvent(updated);

    return this.mapPrismaToEntity(updated);
  }

  /**
   * Find transactions by Stellar hash
   */
  async findByStellarHash(hash: string): Promise<TransactionEntity | null> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { stellarHash: hash },
    });

    return transaction ? this.mapPrismaToEntity(transaction) : null;
  }

  /**
   * Find transactions by wallet ID with pagination metadata
   */
  async findByWallet(
    walletId: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<PaginatedTransactionsDto> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const limit = pagination?.limit ?? 20;
    const offset = pagination?.offset ?? 0;
    const where = {
      OR: [{ senderWalletId: walletId }, { receiverWalletId: walletId }],
    };

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

  private emitStatusDomainEvent(tx: any): void {
    const status = tx.status as TransactionStatus;
    if (status === TransactionStatus.SUBMITTED) {
      this.emitDomainEvent('transaction.submitted', () =>
        this.webhookEventEmitter?.emitTransactionPending({
          transactionId: tx.id,
          walletId: tx.senderWalletId,
          txHash: tx.stellarHash ?? '',
        }),
      );
    } else if (status === TransactionStatus.CONFIRMED) {
      this.emitDomainEvent('transaction.confirmed', () =>
        this.webhookEventEmitter?.emitTransactionConfirmed({
          transactionId: tx.id,
          walletId: tx.senderWalletId,
          txHash: tx.stellarHash ?? '',
          ledger: tx.stellarLedger ?? 0,
          confirmations: 1,
        }),
      );
    } else if (status === TransactionStatus.FAILED) {
      this.emitDomainEvent('transaction.failed', () =>
        this.webhookEventEmitter?.emitTransactionFailed({
          transactionId: tx.id,
          walletId: tx.senderWalletId,
          reason: tx.statusReason ?? 'unknown',
        }),
      );
    }
  }

  private emitDomainEvent(
    eventName: string,
    emit: () => Promise<void> | undefined,
  ): void {
    void Promise.resolve(emit()).catch((error: unknown) =>
      this.logger.warn(
        `Unable to emit ${eventName} domain event: ${String(error)}`,
      ),
    );
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
