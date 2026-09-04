import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { MetricsService } from '../metrics/metrics.service';
import { PAYMENT_LIMITS_PORT } from './ports/payment-limits.port';
import { RequestContextService } from '../common/request-context/request-context.service';
import { PaymentMetricsService } from './payment-metrics.service';
import { ConfigService } from '@nestjs/config';
import { PaymentStatusHistoryService } from './payment-status-history.service';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { PaymentStatus } from './entities/payment.entity';
import { PaymentCreatedEvent } from './events/payment-created.event';
import { PaymentCompletedEvent } from './events/payment-completed.event';
import { PaymentFailedEvent } from './events/payment-failed.event';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';

const ACTIVE_WALLET = { id: 'wallet-uuid-sender', status: WalletStatus.ACTIVE };
const RECEIVER_WALLET = {
  id: 'wallet-uuid-receiver',
  status: WalletStatus.ACTIVE,
};

const BASE_DTO = {
  walletId: 'wallet-uuid-sender',
  receiverWalletId: 'wallet-uuid-receiver',
  fromId: 1,
  toId: 2,
  amount: 100,
  currency: 'USD',
  description: 'Test payment',
};

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: any;
  let paymentLimitsPort: any;
  let walletsService: any;
  let eventEmitter: any;
  let metrics: any;
  let requestContext: any;
  let paymentMetrics: any;
  let configService: any;
  let statusHistory: any;

  beforeEach(async () => {
    prisma = {
      payment: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
    };
    paymentLimitsPort = { checkLimits: jest.fn() };
    walletsService = { findWalletById: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    metrics = {
      incrementPaymentsCreated: jest.fn(),
      incrementPaymentsFailed: jest.fn(),
      recordPaymentProcessingDuration: jest.fn(),
      incrementPaymentIdempotencyHit: jest.fn(),
    };
    requestContext = {
      getRequestId: jest.fn().mockReturnValue('req-1'),
      getClientVersion: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PAYMENT_LIMITS_PORT, useValue: paymentLimitsPort },
        { provide: WalletsService, useValue: walletsService },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: MetricsService, useValue: metrics },
        { provide: RequestContextService, useValue: requestContext },
        { provide: PaymentMetricsService, useValue: paymentMetrics },
        { provide: ConfigService, useValue: configService },
        { provide: PaymentStatusHistoryService, useValue: statusHistory },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('dryRun', () => {
    it('validates the payment and returns a sanitized preview without side effects', async () => {
      const secret = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      walletsService.findWalletById
        .mockResolvedValueOnce({
          ...ACTIVE_WALLET,
          encryptedSecret: 'encrypted-wallet-secret',
          privateKey: secret,
        })
        .mockResolvedValueOnce({
          ...RECEIVER_WALLET,
          encryptedSecret: 'encrypted-receiver-secret',
        });
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);

      const result = await service.dryRun(BASE_DTO);

      expect(result).toEqual({
        dryRun: true,
        valid: true,
        preview: {
          senderWalletId: BASE_DTO.walletId,
          receiverWalletId: BASE_DTO.receiverWalletId,
          fromId: BASE_DTO.fromId,
          toId: BASE_DTO.toId,
          amount: BASE_DTO.amount,
          currency: BASE_DTO.currency,
          status: PaymentStatus.PENDING,
        },
        checks: {
          senderWallet: 'ACTIVE',
          receiverWallet: 'FOUND',
          paymentLimits: 'PASSED',
        },
      });
      expect(paymentLimitsPort.checkLimits).toHaveBeenCalledWith(
        BASE_DTO.walletId,
        BASE_DTO.amount,
      );
      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('encrypted-wallet-secret');
    });

    it('rejects an inactive sender without persisting a payment', async () => {
      walletsService.findWalletById.mockResolvedValue({
        ...ACTIVE_WALLET,
        status: WalletStatus.SUSPENDED,
      });

      await expect(service.dryRun(BASE_DTO)).rejects.toThrow(
        new BadRequestException(
          'Sender wallet is not active (status: SUSPENDED)',
        ),
      );
      expect(paymentLimitsPort.checkLimits).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('propagates payment-limit failures without persistence', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockRejectedValue(
        new BadRequestException('Payment limit exceeded'),
      );

      await expect(service.dryRun(BASE_DTO)).rejects.toThrow(
        'Payment limit exceeded',
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('should create payment when sender wallet is ACTIVE and limits pass', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...BASE_DTO,
        status: PaymentStatus.PENDING,
      });

      const result = await service.create(BASE_DTO);

      expect(walletsService.findWalletById).toHaveBeenCalledWith(
        BASE_DTO.walletId,
      );
      expect(walletsService.findWalletById).toHaveBeenCalledWith(
        BASE_DTO.receiverWalletId,
      );
      expect(paymentLimitsPort.checkLimits).toHaveBeenCalledWith(
        BASE_DTO.walletId,
        BASE_DTO.amount,
        undefined,
      );
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          fromId: BASE_DTO.fromId,
          toId: BASE_DTO.toId,
          amount: BASE_DTO.amount,
          currency: BASE_DTO.currency,
          assetCode: undefined,
          description: BASE_DTO.description,
          userId: BASE_DTO.fromId,
          status: PaymentStatus.PENDING,
          idempotencyKey: null,
        },
      });
      expect(result.status).toBe(PaymentStatus.PENDING);
    });

    it('should create payment with assetCode when provided', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);
      const dtoWithAsset = { ...BASE_DTO, assetCode: 'EUR' };
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...dtoWithAsset,
        status: PaymentStatus.PENDING,
      });

      const result = await service.create(dtoWithAsset);

      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          fromId: dtoWithAsset.fromId,
          toId: dtoWithAsset.toId,
          amount: dtoWithAsset.amount,
          currency: dtoWithAsset.currency,
          assetCode: 'EUR',
          description: dtoWithAsset.description,
          userId: dtoWithAsset.fromId,
          status: PaymentStatus.PENDING,
          idempotencyKey: null,
        },
      });
      expect(result.assetCode).toBe('EUR');
    });

    it('should throw BadRequestException when sender wallet is not ACTIVE', async () => {
      walletsService.findWalletById.mockResolvedValue({
        ...ACTIVE_WALLET,
        status: WalletStatus.SUSPENDED,
      });

      await expect(service.create(BASE_DTO)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update payment status', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 1,
        status: PaymentStatus.PENDING,
      });
      prisma.payment.update.mockResolvedValue({
        id: 1,
        status: PaymentStatus.CONFIRMED,
      });

      const result = await service.update('1', {
        status: PaymentStatus.CONFIRMED,
      });

      expect(result.status).toBe(PaymentStatus.CONFIRMED);
    });

    it('should throw NotFoundException when payment does not exist', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      await expect(
        service.update('99', { status: PaymentStatus.CONFIRMED }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for invalid status transition', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 1,
        status: PaymentStatus.CONFIRMED,
      });

      await expect(
        service.update('1', { status: PaymentStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('business logic validation', () => {
    it('should check limits when creating payment', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...BASE_DTO,
        status: PaymentStatus.PENDING,
      });

      await service.create(BASE_DTO);

      expect(paymentLimitsPort.checkLimits).toHaveBeenCalledWith(
        BASE_DTO.walletId,
        BASE_DTO.amount,
        undefined,
      );
    });
  });

  describe('pagination', () => {
    it('should return paginated results with defaults', async () => {
      const payments = [{ id: 1 }, { id: 2 }];
      prisma.payment.findMany.mockResolvedValue(payments);
      prisma.payment.count.mockResolvedValue(2);

      const result = await service.findAll({ page: 1, limit: 20 }, {});

      expect(result.data).toEqual(payments);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 20,
      });
    });

    it('should apply correct skip offset for page 2', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(100);

      await service.findAll({ page: 2, limit: 20 }, {});

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 20,
        take: 20,
      });
    });
  });

  describe('request id propagation', () => {
    it('should call getRequestId when creating a payment', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...BASE_DTO,
        status: PaymentStatus.PENDING,
      });

      await service.create(BASE_DTO);

      expect(requestContext.getRequestId).toHaveBeenCalled();
    });

    it('should call getRequestId when updating a payment', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 1,
        status: PaymentStatus.PENDING,
      });
      prisma.payment.update.mockResolvedValue({
        id: 1,
        status: PaymentStatus.CONFIRMED,
      });

      await service.update('1', { status: PaymentStatus.CONFIRMED });

      expect(requestContext.getRequestId).toHaveBeenCalled();
    });
  });

  describe('client version propagation (support logs)', () => {
    it('includes the client version in the update log context when the header was present', async () => {
      requestContext.getClientVersion.mockReturnValue('2.4.1');
      prisma.payment.findUnique.mockResolvedValue({
        id: 1,
        status: PaymentStatus.PENDING,
      });
      prisma.payment.update.mockResolvedValue({
        id: 1,
        status: PaymentStatus.CONFIRMED,
      });
      const logSpy = jest.spyOn(
        (service as any).logger,
        'logWithContext',
      );

      await service.update('1', { status: PaymentStatus.CONFIRMED });

      expect(requestContext.getClientVersion).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        'Updating payment',
        expect.objectContaining({ clientVersion: '2.4.1' }),
      );
    });

    it('omits the client version from the log context without breaking the request when the header was absent', async () => {
      requestContext.getClientVersion.mockReturnValue(undefined);
      prisma.payment.findUnique.mockResolvedValue({
        id: 1,
        status: PaymentStatus.PENDING,
      });
      prisma.payment.update.mockResolvedValue({
        id: 1,
        status: PaymentStatus.CONFIRMED,
      });
      const logSpy = jest.spyOn(
        (service as any).logger,
        'logWithContext',
      );

      const result = await service.update('1', {
        status: PaymentStatus.CONFIRMED,
      });

      expect(result).toBeDefined();
      expect(logSpy).toHaveBeenCalledWith(
        'Updating payment',
        expect.objectContaining({ clientVersion: undefined }),
      );
    });
  });

  describe('filtering', () => {
    it('should apply status filter when provided', async () => {
      const payments = [{ id: 1, status: PaymentStatus.PENDING }];
      prisma.payment.findMany.mockResolvedValue(payments);
      prisma.payment.count.mockResolvedValue(1);

      await service.findAll(
        { page: 1, limit: 20 },
        { status: PaymentStatus.PENDING },
      );

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { status: PaymentStatus.PENDING },
        skip: 0,
        take: 20,
      });
      expect(prisma.payment.count).toHaveBeenCalledWith({
        where: { status: PaymentStatus.PENDING },
      });
    });

    it('should not apply filter when not provided', async () => {
      const payments = [{ id: 1 }];
      prisma.payment.findMany.mockResolvedValue(payments);
      prisma.payment.count.mockResolvedValue(100);

      await service.findAll({ page: 1, limit: 20 }, {});

      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 20,
      });
    });
  });

  describe('domain events', () => {
    it('should emit payment.created event on payment creation', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);
      const payment = {
        id: 1,
        ...BASE_DTO,
        status: PaymentStatus.PENDING,
        userId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.payment.create.mockResolvedValue(payment);

      await service.create(BASE_DTO);

      expect(metrics.incrementPaymentsCreated).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.created',
        expect.any(PaymentCreatedEvent),
      );
      const emittedEvent = eventEmitter.emit.mock.calls[0][1];
      expect(emittedEvent.paymentId).toBe(1);
      expect(emittedEvent.amount).toBe(100);
      expect(emittedEvent.currency).toBe('USD');
      expect(emittedEvent.userId).toBe(1);
    });

    it('should emit payment.completed event on CONFIRMED status transition', async () => {
      const payment = {
        id: 1,
        status: PaymentStatus.PENDING,
        amount: 100,
        currency: 'USD',
        userId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.payment.findUnique.mockResolvedValue(payment);
      prisma.payment.update.mockResolvedValue({
        ...payment,
        status: PaymentStatus.CONFIRMED,
      });

      await service.update('1', { status: PaymentStatus.CONFIRMED });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.completed',
        expect.any(PaymentCompletedEvent),
      );
      const emittedEvent = eventEmitter.emit.mock.calls[0][1];
      expect(emittedEvent.paymentId).toBe(1);
      expect(emittedEvent.amount).toBe(100);
    });

    it('should emit payment.failed event on FAILED status transition', async () => {
      const payment = {
        id: 1,
        status: PaymentStatus.PENDING,
        amount: 100,
        currency: 'USD',
        userId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.payment.findUnique.mockResolvedValue(payment);
      prisma.payment.update.mockResolvedValue({
        ...payment,
        status: PaymentStatus.FAILED,
      });

      await service.update('1', { status: PaymentStatus.FAILED });

      expect(metrics.incrementPaymentsFailed).toHaveBeenCalledWith(
        'user_action',
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'payment.failed',
        expect.any(PaymentFailedEvent),
      );
      const emittedEvent = eventEmitter.emit.mock.calls[0][1];
      expect(emittedEvent.paymentId).toBe(1);
      expect(emittedEvent.amount).toBe(100);
    });

    it('should not emit event on description-only update', async () => {
      const payment = {
        id: 1,
        status: PaymentStatus.PENDING,
        amount: 100,
        currency: 'USD',
        userId: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.payment.findUnique.mockResolvedValue(payment);
      prisma.payment.update.mockResolvedValue({
        ...payment,
        description: 'Updated',
      });
      eventEmitter.emit.mockClear();

      await service.update('1', { description: 'Updated' });

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    const idempotencyKey = 'idem-key-1';

    it('returns the existing payment without creating a duplicate when the key was already used', async () => {
      const existingPayment = {
        id: 1,
        ...BASE_DTO,
        idempotencyKey,
        status: PaymentStatus.PENDING,
      };
      prisma.payment.findUnique.mockResolvedValue(existingPayment);

      const result = await service.create({ ...BASE_DTO, idempotencyKey });

      expect(prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey },
      });
      expect(walletsService.findWalletById).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
      expect(metrics.incrementPaymentIdempotencyHit).toHaveBeenCalled();
      expect(result).toBe(existingPayment);
    });

    it('creates a new payment and stores the key when it has not been used before', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...BASE_DTO,
        idempotencyKey,
        status: PaymentStatus.PENDING,
      });

      await service.create({ ...BASE_DTO, idempotencyKey });

      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          fromId: BASE_DTO.fromId,
          toId: BASE_DTO.toId,
          amount: BASE_DTO.amount,
          currency: BASE_DTO.currency,
          description: BASE_DTO.description,
          userId: BASE_DTO.fromId,
          status: PaymentStatus.PENDING,
          idempotencyKey,
        },
      });
      expect(metrics.incrementPaymentIdempotencyHit).not.toHaveBeenCalled();
    });

    it('does not check for an existing payment when no key is provided', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      paymentLimitsPort.checkLimits.mockResolvedValue(undefined);
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...BASE_DTO,
        status: PaymentStatus.PENDING,
      });

      await service.create(BASE_DTO);

      expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    });
  });
});
