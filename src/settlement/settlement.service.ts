import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { RequestContextService } from '../common/request-context/request-context.service';

/**
 * Result of a settlement operation returned to the caller.
 */
export interface SettlementResult {
  /** Unique settlement identifier. */
  id: string;
  /** Client-supplied trade ID (echoed back for convenience). */
  tradeId: string;
  /** Sender wallet ID. */
  senderWalletId: string;
  /** Receiver wallet ID. */
  receiverWalletId: string;
  /** Settlement amount. */
  amount: string;
  /** Settlement status. */
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  /** Whether this result was returned from a previous settlement (idempotent replay). */
  isIdempotent: boolean;
  /** ISO timestamp of the settlement. */
  settledAt: string;
  /** Optional metadata. */
  metadata?: Record<string, any>;
}

/**
 * SettlementService
 *
 * Handles settlement processing with strict idempotency guarantees based on
 * the client-supplied `tradeId`.  Duplicate `tradeId` submissions are
 * detected and the original settlement result is returned, preventing
 * double-settlement without requiring the caller to track state.
 *
 * ## Idempotency contract
 *
 * 1. **First call with a tradeId** – a new settlement is created and the
 *    result is cached under the tradeId for 24 hours.
 *
 * 2. **Duplicate call with the same tradeId** – the cached result is
 *    replayed.  The `isIdempotent` flag is set to `true` so the caller can
 *    distinguish first-settlement from replay.
 *
 * 3. **Expired cache** – treated as a new settlement; a fresh entry is
 *    stored.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  /** Settlement idempotency cache TTL: 24 hours. */
  private readonly IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  /**
   * Process a settlement idempotently.
   *
   * If a settlement with the same `tradeId` was already processed, the
   * original result is returned without creating a duplicate.
   */
  async settle(
    dto: CreateSettlementDto,
  ): Promise<SettlementResult> {
    const requestId = RequestContextService.getCurrentRequestId();
    const logCtx = `tradeId=${dto.tradeId} sender=${dto.senderWalletId} receiver=${dto.receiverWalletId} requestId=${requestId || 'N/A'}`;

    // --- Phase 1: Idempotency check ---
    const cached = await this.idempotencyService.getCachedResponse(
      `settlement:${dto.tradeId}`,
    );
    if (cached) {
      this.logger.log(`Idempotent settlement replay for ${logCtx}`);
      return {
        ...cached,
        isIdempotent: true,
      };
    }

    // --- Phase 2: Validate wallets exist ---
    const [senderWallet, receiverWallet] = await Promise.all([
      this.prisma.wallet.findUnique({ where: { id: dto.senderWalletId } }),
      this.prisma.wallet.findUnique({ where: { id: dto.receiverWalletId } }),
    ]);

    if (!senderWallet) {
      throw new NotFoundException(
        `Sender wallet ${dto.senderWalletId} not found`,
      );
    }

    if (!receiverWallet) {
      throw new NotFoundException(
        `Receiver wallet ${dto.receiverWalletId} not found`,
      );
    }

    // --- Phase 3: Validate sender and receiver are different ---
    if (dto.senderWalletId === dto.receiverWalletId) {
      throw new BadRequestException(
        'Sender and receiver wallets must be different',
      );
    }

    // --- Phase 4: Process settlement ---
    try {
      const settlementRecord = await this.prisma.settlement.create({
        data: {
          tradeId: dto.tradeId,
          senderWalletId: dto.senderWalletId,
          receiverWalletId: dto.receiverWalletId,
          amount: dto.amount,
          metadata: dto.metadata ?? {},
          status: 'COMPLETED',
        },
      });

      const result: SettlementResult = {
        id: settlementRecord.id,
        tradeId: settlementRecord.tradeId,
        senderWalletId: settlementRecord.senderWalletId,
        receiverWalletId: settlementRecord.receiverWalletId,
        amount: settlementRecord.amount,
        status: settlementRecord.status as 'COMPLETED',
        isIdempotent: false,
        settledAt: settlementRecord.createdAt.toISOString(),
        metadata: settlementRecord.metadata as Record<string, any> | undefined,
      };

      // Cache the result for idempotent replays
      await this.idempotencyService.cacheResponse(
        `settlement:${dto.tradeId}`,
        result,
        'POST',
        '/v1/settlements',
        200,
        { ttlMs: this.IDEMPOTENCY_TTL_MS },
      );

      this.logger.log(`Settlement completed for ${logCtx} id=${result.id}`);
      return result;
    } catch (error: any) {
      // Handle Prisma unique constraint violation on tradeId
      if (error?.code === 'P2002') {
        return this.handleConcurrentDuplicate(dto, logCtx);
      }

      this.logger.error(
        `Settlement failed for ${logCtx}: ${error?.message || error}`,
      );
      throw error;
    }
  }

  /**
   * Handles a concurrent duplicate submission where two requests with the
   * same tradeId arrive simultaneously and the unique constraint caught the
   * second one.
   */
  private async handleConcurrentDuplicate(
    dto: CreateSettlementDto,
    logCtx: string,
  ): Promise<SettlementResult> {
    // Try the idempotency cache first
    const retryCached = await this.idempotencyService.getCachedResponse(
      `settlement:${dto.tradeId}`,
    );
    if (retryCached) {
      this.logger.log(
        `Race condition resolved for ${logCtx} — returning cached result`,
      );
      return { ...retryCached, isIdempotent: true };
    }

    // Fall back to querying settlement directly
    const existing = await this.prisma.settlement.findUnique({
      where: { tradeId: dto.tradeId },
    });
    if (existing) {
      this.logger.log(
        `Race condition resolved for ${logCtx} — returning direct lookup`,
      );
      return {
        id: existing.id,
        tradeId: existing.tradeId,
        senderWalletId: existing.senderWalletId,
        receiverWalletId: existing.receiverWalletId,
        amount: existing.amount,
        status: existing.status as 'COMPLETED',
        isIdempotent: true,
        settledAt: existing.createdAt.toISOString(),
        metadata: existing.metadata as Record<string, any> | undefined,
      };
    }

    // Should not reach here, but if we do, throw
    throw new ConflictException(
      `Duplicate tradeId ${dto.tradeId} with no existing settlement record`,
    );
  }

  /**
   * Retrieves a settlement by its tradeId.
   * Returns null if no settlement exists for the given tradeId.
   */
  async findByTradeId(tradeId: string): Promise<SettlementResult | null> {
    const record = await this.prisma.settlement.findUnique({
      where: { tradeId },
    });
    if (!record) return null;

    return {
      id: record.id,
      tradeId: record.tradeId,
      senderWalletId: record.senderWalletId,
      receiverWalletId: record.receiverWalletId,
      amount: record.amount,
      status: record.status as 'COMPLETED',
      isIdempotent: true,
      settledAt: record.createdAt.toISOString(),
      metadata: record.metadata as Record<string, any> | undefined,
    };
  }
}

