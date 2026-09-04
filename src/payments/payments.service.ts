import {
  Inject,
  Injectable,
  Optional,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentDryRunResponseDto } from './dto/payment-dry-run-response.dto';
import { BatchPaymentDto } from './dto/batch-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import {
  PAYMENT_LIMITS_PORT,
  PaymentLimitsPort,
} from './ports/payment-limits.port';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { PaymentStatus } from './entities/payment.entity';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';
import { PaymentsFilterDto } from './dto/payments-filter.dto';
import { PaymentCreatedEvent } from './events/payment-created.event';
import { PaymentCompletedEvent } from './events/payment-completed.event';
import { PaymentFailedEvent } from './events/payment-failed.event';
import { retryWithBackoff } from '../common/utils/retry';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { PaymentMetricsService } from './payment-metrics.service';
import { StructuredLogger } from '../common/logging/structured-logger';
import { PaymentStatusHistoryService } from './payment-status-history.service';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionStatus } from '../transactions/domain/transaction.model';
import { AssetType } from '../balance-indexer/domain/balance.model';
import { StellarTransactionBuildService } from '../transactions/stellar-transaction-build.service';
import { HorizonSubmissionService } from '../transactions/horizon-submission.service';

// Only PENDING payments can be transitioned; terminal states are immutable.
const ALLOWED_TRANSITIONS: Record<string, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
};

@Injectable()
export class PaymentsService {
  private readonly logger = new StructuredLogger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_LIMITS_PORT)
    private readonly paymentLimitsPort: PaymentLimitsPort,
    private readonly walletsService: WalletsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
    private readonly paymentMetrics: PaymentMetricsService,
    private readonly configService: ConfigService,
    private readonly statusHistory: PaymentStatusHistoryService,
    @Optional() private readonly transactionsService?: TransactionsService,
    @Optional() private readonly transactionBuildService?: StellarTransactionBuildService,
    @Optional() private readonly horizonSubmissionService?: HorizonSubmissionService,
  ) {}

  /**
   * Validate a payment exactly as creation does, without signing, submitting,
   * persisting a payment, or emitting a domain event.
   */
  async dryRun(
    createPaymentDto: CreatePaymentDto,
  ): Promise<PaymentDryRunResponseDto> {
    await this.validateForCreation(createPaymentDto);

    return {
      dryRun: true,
      valid: true,
      preview: {
        senderWalletId: createPaymentDto.walletId,
        receiverWalletId: createPaymentDto.receiverWalletId,
        fromId: createPaymentDto.fromId,
        toId: createPaymentDto.toId,
        amount: createPaymentDto.amount,
        currency: createPaymentDto.currency,
        ...(createPaymentDto.assetCode
          ? { assetCode: createPaymentDto.assetCode }
          : {}),
        status: PaymentStatus.PENDING,
      },
      checks: {
        senderWallet: 'ACTIVE',
        receiverWallet: 'FOUND',
        paymentLimits: 'PASSED',
      },
    };
  }

  async create(createPaymentDto: CreatePaymentDto) {
    if (
      process.env.NODE_ENV === 'production' &&
      (!this.transactionsService ||
        !this.transactionBuildService ||
        !this.horizonSubmissionService)
    ) {
      throw new Error('Payment transaction orchestration is not configured');
    }
    const requestId = this.requestContext.getRequestId();
    const clientVersion = this.requestContext.getClientVersion();
    const start = Date.now();
    const {
      fromId,
      toId,
      amount,
      currency,
      assetCode,
      description,
      idempotencyKey,
    } = createPaymentDto;

    if (idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.logWithContext('Idempotency hit, returning existing payment', {
          requestId,
          clientVersion,
          entityId: existing.id.toString(),
          entityType: 'payment',
          operation: 'create',
          outcome: 'idempotent',
        });
        this.metrics.incrementPaymentIdempotencyHit();
        this.paymentMetrics.record({
          operation: 'create',
          outcome: 'idempotent',
          durationMs: Date.now() - start,
          currency,
        });
        return existing;
      }
    }

    try {
      await this.validateForCreation(createPaymentDto);

      const payment = await this.prisma.payment.create({
        data: {
          fromId,
          toId,
          amount,
          currency,
          assetCode,
          description,
          userId: fromId,
          status: PaymentStatus.PENDING,
          idempotencyKey: idempotencyKey ?? null,
          senderWalletId: createPaymentDto.walletId,
          receiverWalletId: createPaymentDto.receiverWalletId,
        },
      });

      let transaction: any;
      if (this.transactionsService && this.transactionBuildService && this.horizonSubmissionService) {
        transaction = await this.transactionsService.create({
          amount: String(amount),
          asset: {
            type: currency.toUpperCase() === 'XLM' ? AssetType.NATIVE : AssetType.CREDIT_ALPHANUM4,
            ...(currency.toUpperCase() !== 'XLM' ? { code: assetCode ?? currency } : {}),
          },
          senderWalletId: createPaymentDto.walletId,
          receiverWalletId: createPaymentDto.receiverWalletId,
          metadata: { legacyPaymentId: payment.id, description },
          idempotencyKey: idempotencyKey ? `payment:${idempotencyKey}` : undefined,
        });
        const sender = await this.walletsService.findWalletById(createPaymentDto.walletId);
        const receiver = await this.walletsService.findWalletById(createPaymentDto.receiverWalletId);
        const built = await this.transactionBuildService.buildPayment({
          sourcePublicKey: sender.publicKey,
          destinationPublicKey: receiver.publicKey,
          amount: String(amount),
          assetCode: currency.toUpperCase() === 'XLM' ? 'native' : (assetCode ?? currency),
          network: sender.network,
        });
        const signedXdr = await this.walletsService.signStellarEnvelope(createPaymentDto.walletId, built.xdr);
        const submission = await this.horizonSubmissionService.submitTransaction(transaction.id, signedXdr);
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            transactionId: transaction.id,
            status: submission.status === TransactionStatus.FAILED ? PaymentStatus.FAILED : PaymentStatus.CONFIRMED,
          },
        });
      }

      this.metrics.incrementPaymentsCreated();
      this.paymentMetrics.record({
        operation: 'create',
        outcome: 'success',
        durationMs: Date.now() - start,
        currency,
      });

      this.eventEmitter.emit(
        'payment.created',
        new PaymentCreatedEvent(
          payment.id,
          payment.amount,
          payment.currency,
          payment.userId,
        ),
      );

      return payment;
    } catch (err) {
      this.paymentMetrics.record({
        operation: 'create',
        outcome: 'failure',
        durationMs: Date.now() - start,
        currency,
        failureReason: err?.constructor?.name ?? 'unknown',
      });
      throw err;
    }
  }

  async createBatch(dto: BatchPaymentDto) {
    // The BatchPaymentDto enforces ArrayMinSize(1) via class-validator so this
    // guard is a safety net for callers that bypass the validation pipe.
    if (!dto.payments || dto.payments.length === 0) {
      throw new BadRequestException('payments must not be empty');
    }
    return Promise.all(dto.payments.map((p) => this.create(p)));
  }

  private async validateForCreation(
    createPaymentDto: CreatePaymentDto,
  ): Promise<void> {
    const { walletId, receiverWalletId, fromId, toId, amount } =
      createPaymentDto;
    const senderWallet = await retryWithBackoff(
      () => this.walletsService.findWalletById(walletId),
      3,
      100,
      this.logger,
    );
    if (senderWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException(
        `Sender wallet is not active (status: ${senderWallet.status})`,
      );
    }

    const blockSelfPayments = this.configService.get<boolean>(
      'BLOCK_SELF_PAYMENTS',
      false,
    );
    if (blockSelfPayments && fromId === toId) {
      throw new BadRequestException('Payments to self are not allowed');
    }

    await retryWithBackoff(
      () => this.walletsService.findWalletById(receiverWalletId),
      3,
      100,
      this.logger,
    );
    await retryWithBackoff(
      () => this.paymentLimitsPort.checkLimits(walletId, amount, assetCode),
      3,
      100,
      this.logger,
    );
  }

  async findAll(
    pagination: PaginationDto,
    filters: PaymentsFilterDto,
  ): Promise<PaginatedResponse<any>> {
    const skip = (pagination.page - 1) * pagination.limit;

    const where: any = {};
    if (filters.status) {
      where.status = filters.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: pagination.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data,
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  findOne(id: string) {
    return this.prisma.payment.findUnique({
      where: { id: parseInt(id, 10) },
    });
  }

  async update(id: string, updatePaymentDto: UpdatePaymentDto) {
    const requestId = this.requestContext.getRequestId();
    const clientVersion = this.requestContext.getClientVersion();
    const paymentId = parseInt(id, 10);

    this.logger.logWithContext('Updating payment', {
      requestId,
      clientVersion,
      entityId: paymentId.toString(),
      entityType: 'payment',
      operation: 'update',
    });

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) {
      throw new NotFoundException(`Payment #${paymentId} not found`);
    }

    if (updatePaymentDto.status !== undefined) {
      const allowed = ALLOWED_TRANSITIONS[payment.status] ?? [];
      if (!allowed.includes(updatePaymentDto.status)) {
        throw new BadRequestException(
          `Cannot transition payment from ${payment.status} to ${updatePaymentDto.status}`,
        );
      }
    }

    const updatedPayment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: updatePaymentDto,
    });

    // Record status change in history table (best-effort, non-blocking)
    if (updatePaymentDto.status !== undefined) {
      void this.statusHistory.recordStatusChange({
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: updatePaymentDto.status,
        changedBy: 'api',
        metadata: { requestId },
      });
    }

    if (updatePaymentDto.status === PaymentStatus.CONFIRMED) {
      this.eventEmitter.emit(
        'payment.completed',
        new PaymentCompletedEvent(
          updatedPayment.id,
          updatedPayment.amount,
          updatedPayment.currency,
          updatedPayment.userId,
        ),
      );

      await this.webhookEventEmitter.emitPaymentCompleted({
        paymentId: updatedPayment.id,
        amount: updatedPayment.amount,
        currency: updatedPayment.currency,
        assetCode: updatedPayment.assetCode ?? null,
        userId: updatedPayment.userId,
        status: updatedPayment.status,
      });
    } else if (updatePaymentDto.status === PaymentStatus.FAILED) {
      this.metrics.incrementPaymentsFailed('user_action');
      this.eventEmitter.emit(
        'payment.failed',
        new PaymentFailedEvent(
          updatedPayment.id,
          updatedPayment.amount,
          updatedPayment.currency,
          updatedPayment.userId,
        ),
      );

      await this.webhookEventEmitter.emitPaymentFailed({
        paymentId: updatedPayment.id,
        amount: updatedPayment.amount,
        currency: updatedPayment.currency,
        assetCode: updatedPayment.assetCode ?? null,
        userId: updatedPayment.userId,
        status: updatedPayment.status,
      });
    }

    return updatedPayment;
  }

  remove(id: string) {
    return `This action removes payment ${id}`;
  }
}
