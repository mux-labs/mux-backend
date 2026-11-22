import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
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
import { ErrorCode } from '../common/dto/error-envelope.dto';
import { InsufficientBalanceException } from './domain/insufficient-balance.exception';
import { compareDecimalStrings } from './domain/decimal-amount';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { WalletStatus } from '../wallets/domain/wallet.model';

/** Cursor-based page of transactions */
export interface TransactionPage {
  data: TransactionEntity[];
  /** Opaque cursor — pass as `cursor` on the next request to get the next page */
  nextCursor: string | null;
  /** Whether more records exist after this page */
  hasMore: boolean;
}

/**
 * Maximum number of integer digits an amount may have.  The amount column is
 * a fixed-precision decimal; anything wider cannot be stored without loss.
 */
const MAX_INTEGER_DIGITS = 18;

/** Maximum number of fractional digits an amount may have. */
const MAX_FRACTIONAL_DIGITS = 7;

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
   * transaction with that key already exists for the same sender wallet, the
   * existing transaction is returned without side-effects. A key already used
   * by a different sender wallet is rejected with 409 (IDEMPOTENCY_CONFLICT)
   * so another wallet's transaction is never exposed.
   *
   * The sender wallet must be owned by `callerDeveloperId` (taken from the API
   * key context, never the body) and both wallets must be ACTIVE. An ownership
   * miss is reported as WALLET_NOT_FOUND so wallet existence is not leaked.
   */
  async create(
    createTransactionDto: CreateTransactionDto,
    callerDeveloperId: string,
  ): Promise<TransactionEntity> {
    this.assertValidAmount(createTransactionDto.amount);

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
        if (existing.senderWalletId !== senderWalletId) {
          throw new ConflictException({
            message:
              'Idempotency key is already used by another sender wallet',
            errorCode: 'IDEMPOTENCY_CONFLICT',
          });
        }
        this.logger.log(
          `Idempotency hit for key ${idempotencyKey}, returning existing transaction ${existing.id}`,
        );
        return this.mapPrismaToEntity(existing);
      }
    }

    // Validate sender wallet exists, is owned by the caller and is ACTIVE.
    // Ownership misses are treated as not found to avoid leaking existence.
    const senderWallet = await this.prisma.wallet.findUnique({
      where: { id: senderWalletId },
    });
    if (!senderWallet || senderWallet.userId !== callerDeveloperId) {
      throw new NotFoundException({
        errorCode: 'WALLET_NOT_FOUND',
        message: `Sender wallet ${senderWalletId} not found for this developer`,
      });
    }
    if (senderWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException({
        errorCode: 'WALLET_NOT_ACTIVE',
        message: `Sender wallet is not active (status: ${senderWallet.status})`,
      });
    }

    // Validate receiver wallet exists and is ACTIVE (if supplied)
    if (receiverWalletId) {
      const receiverWallet = await this.prisma.wallet.findUnique({
        where: { id: receiverWalletId },
      });
      if (!receiverWallet) {
        throw new NotFoundException(
          `Receiver wallet ${receiverWalletId} not found`,
        );
      }
      if (receiverWallet.status !== WalletStatus.ACTIVE) {
        throw new BadRequestException({
          errorCode: 'WALLET_NOT_ACTIVE',
          message: `Receiver wallet is not active (status: ${receiverWallet.status})`,
        });
      }
    }

    // A self-payment can never settle, so reject it before any balance,
    // limit or write side effect
    if (receiverWalletId && receiverWalletId === senderWalletId) {
      throw new BadRequestException({
        message: 'Sender and receiver wallet must differ',
        errorCode: ErrorCode.TRANSACTION_SELF_PAYMENT,
      });
    }

    // Check sender has sufficient balance
    const balanceAsset: Asset = {
      type: asset.type as any,
      code: asset.code ?? undefined,
      issuer: asset.issuer ?? undefined,
    };
    // The precheck runs as the sender wallet's owner, taken from the stored row
    // rather than the request, so the indexer's ownership check still applies.
    const walletBalance = await this.balanceIndexer.getBalance(
      {
        subjectId: senderWallet.userId,
        role: 'owner',
        correlationId: randomUUID(),
      },
      senderWalletId,
      balanceAsset,
    );
    const available = walletBalance?.balance ?? '0';
    if (compareDecimalStrings(available, amount) < 0) {
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
    if (filters?.cursor !== undefined && filters?.offset !== undefined) {
      throw new BadRequestException(
        'cursor and offset are mutually exclusive',
      );
    }

    const limit = Math.min(filters?.limit ?? 20, 100);

    const where: Record<string, unknown> = {};
    if (filters?.senderWalletId) where.senderWalletId = filters.senderWalletId;
    if (filters?.receiverWalletId)
      where.receiverWalletId = filters.receiverWalletId;
    if (filters?.status) where.status = filters.status;

    if (filters?.cursor) {
      // Fetch the cursor row to get its createdAt for stable ordering
      const cursorRow = await this.prisma.transaction.findUnique({
        where: { id: filters.cursor },
      });
      if (!cursorRow) {
        throw new BadRequestException('Invalid cursor');
      }
      where.OR = [
        { createdAt: { lt: cursorRow.createdAt } },
        {
          createdAt: cursorRow.createdAt,
          id: { lt: cursorRow.id },
        },
      ];
    }

    const rows = await this.prisma.transaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(filters?.offset !== undefined && !filters?.cursor
        ? { skip: filters.offset }
        : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    return {
      data: page.map((row) => this.mapPrismaToEntity(row)),
      nextCursor,
      hasMore,
    };
  }

  /**
   * Fetch a single transaction by id.
   */
  async findOne(id: string): Promise<TransactionEntity> {
    const row = await this.prisma.transaction.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }
    return this.mapPrismaToEntity(row);
  }

  /**
   * Update a transaction's status, enforcing the state machine.
   */
  async updateStatus(
    id: string,
    dto: UpdateTransactionStatusDto,
  ): Promise<TransactionEntity> {
    const row = await this.prisma.transaction.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    const current = row.status as TransactionStatus;
    if (!canTransitionTransactionStatus(current, dto.status)) {
      throw new BadRequestException({
        errorCode: 'INVALID_STATUS_TRANSITION',
        message: `Cannot transition from ${current} to ${dto.status}`,
      });
    }

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: { status: dto.status },
    });

    return this.mapPrismaToEntity(updated);
  }

  /**
   * Validate a decimal amount string without relying on `Number`.
   *
   * The amount must be a plain decimal (`^\d+(\.\d{1,7})?$`), with at most
   * 7 fractional digits and an integer part that fits the storage column.
   * Acceptance is decided purely on the string, so values that `Number`
   * cannot represent exactly (e.g. `9007199254740993`) are never silently
   * rounded — they are rejected when they exceed the column width.
   */
  private assertValidAmount(amount: string): void {
    if (typeof amount !== 'string' || !/^\d+(\.\d{1,7})?$/.test(amount)) {
      throw new BadRequestException({
        errorCode: 'INVALID_AMOUNT',
        message: 'Amount must be a positive decimal with at most 7 fractional digits',
      });
    }

    const [integerPart, fractionalPart = ''] = amount.split('.');

    // Reject values whose integer part cannot fit the storage column.
    const significantInteger = integerPart.replace(/^0+(?=\d)/, '');
    if (significantInteger.length > MAX_INTEGER_DIGITS) {
      throw new BadRequestException({
        errorCode: 'INVALID_AMOUNT',
        message: `Amount integer part must not exceed ${MAX_INTEGER_DIGITS} digits`,
      });
    }

    // Fractional part is already bounded by the regex; assert defensively.
    if (fractionalPart.length > MAX_FRACTIONAL_DIGITS) {
      throw new BadRequestException({
        errorCode: 'INVALID_AMOUNT',
        message: `Amount must have at most ${MAX_FRACTIONAL_DIGITS} fractional digits`,
      });
    }

    // Reject zero amounts (all digits zero, no non-zero fractional digit).
    if (/^0*$/.test(integerPart) && /^0*$/.test(fractionalPart)) {
      throw new BadRequestException({
        errorCode: 'INVALID_AMOUNT',
        message: 'Amount must be greater than 0',
      });
    }
  }

  private mapPrismaToEntity(row: {
    id: string;
    amount: string;
    assetType: string;
    assetCode: string | null;
    assetIssuer: string | null;
    senderWalletId: string;
    receiverWalletId: string | null;
    status: string;
    metadata: unknown;
    idempotencyKey: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): TransactionEntity {
    return {
      id: row.id,
      amount: row.amount,
      asset: {
        type: row.assetType as any,
        code: row.assetCode ?? undefined,
        issuer: row.assetIssuer ?? undefined,
      },
      senderWalletId: row.senderWalletId,
      receiverWalletId: row.receiverWalletId ?? undefined,
      status: row.status as TransactionStatus,
      metadata: (row.metadata as Record<string, unknown>) ?? undefined,
      idempotencyKey: row.idempotencyKey ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
