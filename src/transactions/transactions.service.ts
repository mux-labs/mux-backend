import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionStatusDto } from './dto/update-transaction.dto';
import {
  Transaction,
  TransactionStatus,
  createTransaction,
  transitionTransactionStatus,
  canTransitionTransactionStatus,
  TransactionAsset,
  StellarNetworkReferences,
} from './domain/transaction.model';
import { Transaction as TransactionEntity } from './entities/transaction.entity';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new transaction in PENDING state
   */
  async create(createTransactionDto: CreateTransactionDto): Promise<TransactionEntity> {
    const { amount, asset, senderWalletId, receiverWalletId, metadata } = createTransactionDto;

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
        throw new NotFoundException(`Receiver wallet ${receiverWalletId} not found`);
      }
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
        status: TransactionStatus.PENDING,
        metadata: metadata ?? null,
      },
    });

    this.logger.log(`Created transaction ${created.id} in PENDING state`);

    return this.mapPrismaToEntity(created);
  }

  /**
   * Find all transactions with optional filters
   */
  async findAll(filters?: {
    senderWalletId?: string;
    receiverWalletId?: string;
    status?: TransactionStatus;
    limit?: number;
    offset?: number;
  }): Promise<TransactionEntity[]> {
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

    const transactions = await this.prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filters?.limit,
      skip: filters?.offset,
    });

    return transactions.map((t) => this.mapPrismaToEntity(t));
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

    // Validate status transition
    if (!canTransitionTransactionStatus(existing.status as TransactionStatus, updateDto.status)) {
      throw new BadRequestException(
        `Invalid status transition: ${existing.status} -> ${updateDto.status}`,
      );
    }

    // Build update data
    const updateData: any = {
      status: updateDto.status,
      statusChangedAt: new Date(),
      updatedAt: new Date(),
    };

    // Update status-specific timestamps
    if (updateDto.status === TransactionStatus.SUBMITTED) {
      updateData.submittedAt = new Date();
    } else if (updateDto.status === TransactionStatus.CONFIRMED) {
      updateData.confirmedAt = new Date();
    } else if (updateDto.status === TransactionStatus.FAILED) {
      updateData.failedAt = new Date();
    }

    // Update status reason if provided
    if (updateDto.statusReason !== undefined) {
      updateData.statusReason = updateDto.statusReason;
    }

    // Update Stellar network references if provided
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
   * Find transactions by wallet ID
   */
  async findByWallet(walletId: string): Promise<TransactionEntity[]> {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        OR: [
          { senderWalletId: walletId },
          { receiverWalletId: walletId },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    return transactions.map((t) => this.mapPrismaToEntity(t));
  }

  /**
   * Map Prisma model to entity
   */
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
      createdAt: prismaTransaction.createdAt,
      updatedAt: prismaTransaction.updatedAt,
    };
  }
}
