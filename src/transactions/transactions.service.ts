import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceIndexerService } from '../balance-indexer/balance-indexer.service';
import { LimitsService } from '../limits/limits.service';
import { Asset } from '../balance-indexer/domain/balance.model';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionStatusDto } from './dto/update-transaction.dto';
import {
  TransactionStatus,
  canTransitionTransactionStatus,
} from './domain/transaction.model';
import { Transaction as TransactionEntity } from './entities/transaction.entity';
import { InsufficientBalanceException } from './domain/insufficient-balance.exception';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';

/** Cursor-based page of transactions */
export interface TransactionPage {
  data: TransactionEntity[];
  /** Opaque cursor — pass as `cursor` on the next request to get the next page */
  nextCursor: string | null;
  /** Whether more records exist after this page */
  hasMore: boolean;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceIndexer: BalanceIndexerService,
    private readonly webhookEventEmitter: WebhookEventEmitterService,
    private readonly limitsService: LimitsService,
  ) {}

  /**
   * Create a new transaction in PENDING state.
   *
   * Enforces per-transaction and daily spending limits (fail-closed: 403)
   * before creating the record.  If an idempotencyKey is supplied and a
   * transaction with that key already exists, the existing transaction is
   * returned without side-effects.
   */
  async create(
    createTransactionDto: CreateTransactionDto,
  ): Promise<TransactionEntity> {
    const {
      amount,
      asset,
      senderWalletId,
      receiverWalletId,
      metadata,
      idempotencyKey,
    } = createTransactionDto;

    // Idempotency check: return existing transaction if key already used
    if (idempotencyKey) {
      const existing = await this.prisma.transaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.log(
          `Idempotency hit for key ${idempotencyKey}, returning existing transaction ${existing.id}`,
        );
        return this.mapPrismaToEntity(existing);
      }
    }

    // Validate sender wallet exists
    const senderWallet = await this.prisma.wallet.findUnique({
      where: { id: senderWalletId },
    });
    if (!senderWallet) {
      throw new NotFoundException(`Sender wallet ${senderWalletId} not found`);
    }

    // Validate receiver wallet exists (if supplied)
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

    // Enforce per-transaction and daily spending limits (fail-closed: 403 on violation)
    await this.limitsService.checkLimits(senderWalletId, amount);

    // Create transaction in database
    const created = await this.prisma.transaction.create({
      data: {
        amount,
        assetType: asset.type,
        assetCode: asset.code ?? null,
        assetIssuer: asset.issuer ?? null,
        senderWalletId,
        receiverWalletId: receiverWalletId ?? null,
        status: TransactionStatus.PENDING,
        metadata: metadata ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    this.webhookEventEmitter
      .emitTransactionCreated({
        transactionId: created.id,
        walletId: created.senderWalletId,
        amount: created.amount,
        asset: created.assetCode ?? created.assetType,
        destination: created.receiverWalletId ?? '',
      })
      .catch((err) =>
        this.logger.error(
          `Failed to emit transaction.created webhook for ${created.id}: ${err?.message}`,
        ),
      );

    return this.mapPrismaToEntity(created);
  }

  /**
   * List transactions with optional filters and cursor-based pagination.
   *
   * Cursor pagination (preferred over offset for stability):
   *   Pass `cursor` (a transaction `id`) to fetch records older than that
   *   transaction.  The response includes `nextCursor` and `hasMore`.
   *
   * Offset pagination (legacy, mutually exclusive with cursor):
   *   Pass `offset` to skip N records.
   */
  async findAll(filters?: {
    senderWalletId?: string;
    receiverWalletId?: string;
    status?: TransactionStatus;
    limit?: number;
    offset?: number;
    cursor?: string;
  }): Promise<TransactionPage> {
    const pageSize = Math.min(filters?.limit ?? 20, 100);
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

    // Cursor-based pagination: compound cursor on (createdAt DESC, id DESC)
    if (filters?.cursor) {
      const pivot = await this.prisma.transaction.findUnique({
        where: { id: filters.cursor },
        select: { createdAt: true, id: true },
      });
      if (!pivot) {
        throw new BadRequestException(
          `Invalid pagination cursor: ${filters.cursor}`,
        );
      }
      where.OR = [
        { createdAt: { lt: pivot.createdAt } },
        { createdAt: pivot.createdAt, id: { lt: pivot.id } },
      ];
    }

    // Fetch one extra to detect hasMore
    const transactions = await this.prisma.transaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      skip: filters?.cursor ? undefined : filters?.offset,
    });

    const hasMore = transactions.length > pageSize;
    const data = transactions
      .slice(0, pageSize)
      .map((t) => this.mapPrismaToEntity(t));
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data, nextCursor, hasMore };
  }

  /**
   * Find a transaction by ID
   */
  async findOne(id: string): Promise<TransactionEntity> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    return this.mapPrismaToEntity(transaction);
  }

  /**
   * Update transaction status with proper state-transition validation
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

    this.logger.log(
      `Updated transaction ${id} status: ${existing.status} -> ${updateDto.status}`,
    );

    this.emitStatusWebhook(updated).catch((err) =>
      this.logger.error(
        `Failed to emit webhook for transaction ${id} status ${updateDto.status}: ${err?.message}`,
      ),
    );

    return this.mapPrismaToEntity(updated);
  }

  /**
   * Find a transaction by Stellar hash
   */
  async findByStellarHash(hash: string): Promise<TransactionEntity | null> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { stellarHash: hash },
    });

    return transaction ? this.mapPrismaToEntity(transaction) : null;
  }

  /**
   * Find transactions for a wallet with cursor-based pagination.
   */
  async findByWallet(
    walletId: string,
    pagination?: { limit?: number; offset?: number; cursor?: string },
  ): Promise<TransactionPage> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const pageSize = Math.min(pagination?.limit ?? 20, 100);
    let where: any;

    if (pagination?.cursor) {
      const pivot = await this.prisma.transaction.findUnique({
        where: { id: pagination.cursor },
        select: { createdAt: true, id: true },
      });
      if (!pivot) {
        throw new BadRequestException(
          `Invalid pagination cursor: ${pagination.cursor}`,
        );
      }
      where = {
        AND: [
          { OR: [{ senderWalletId: walletId }, { receiverWalletId: walletId }] },
          {
            OR: [
              { createdAt: { lt: pivot.createdAt } },
              { createdAt: pivot.createdAt, id: { lt: pivot.id } },
            ],
          },
        ],
      };
    } else {
      where = {
        OR: [{ senderWalletId: walletId }, { receiverWalletId: walletId }],
      };
    }

    const transactions = await this.prisma.transaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      skip: pagination?.cursor ? undefined : pagination?.offset,
    });

    const hasMore = transactions.length > pageSize;
    const data = transactions
      .slice(0, pageSize)
      .map((t) => this.mapPrismaToEntity(t));
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data, nextCursor, hasMore };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async emitStatusWebhook(tx: any): Promise<void> {
    const status = tx.status as TransactionStatus;
    if (status === TransactionStatus.SUBMITTED) {
      await this.webhookEventEmitter.emitTransactionPending({
        transactionId: tx.id,
        walletId: tx.senderWalletId,
        txHash: tx.stellarHash ?? '',
      });
    } else if (status === TransactionStatus.CONFIRMED) {
      await this.webhookEventEmitter.emitTransactionConfirmed({
        transactionId: tx.id,
        walletId: tx.senderWalletId,
        txHash: tx.stellarHash ?? '',
        ledger: tx.stellarLedger ?? 0,
        confirmations: 1,
      });
    } else if (status === TransactionStatus.FAILED) {
      await this.webhookEventEmitter.emitTransactionFailed({
        transactionId: tx.id,
        walletId: tx.senderWalletId,
        reason: tx.statusReason ?? 'unknown',
      });
    }
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
