import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { LimitsService, LimitExceededException } from '../limits/limits.service';
import { WalletsService } from '../wallets/wallets.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentStatus } from './entities/payment.entity';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { RequestContextService } from '../common/request-context/request-context.service';
import { PAYMENT_LIMITS_PORT } from './ports/payment-limits.port';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MetricsService } from '../metrics/metrics.service';
import { PaymentMetricsService } from './payment-metrics.service';
import { ConfigService } from '@nestjs/config';

describe('Payments and Limits Integration', () => {
  let paymentsService: PaymentsService;
  let limitsService: LimitsService;
  let walletsService: WalletsService;
  let prisma: PrismaService;

  const testWalletId = 'test-wallet-sender';
  const testReceiverWalletId = 'test-wallet-receiver';
  const testUserId = 1;
  const testReceiverUserId = 2;

  const mockPrisma = {
    wallet: { findUnique: jest.fn(), update: jest.fn() },
    walletLimit: { upsert: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
    payment: { create: jest.fn(), findMany: jest.fn() },
    transaction: { findMany: jest.fn() },
    legacyUser: {},
    $transaction: jest.fn((cb: any) => cb(mockPrisma)),
  };

  const mockWalletsService = {
    findWalletById: jest.fn(),
  };

  const mockRequestContext = {
    getRequestId: jest.fn().mockReturnValue('integration-req-id'),
    getClientVersion: jest.fn().mockReturnValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        LimitsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PAYMENT_LIMITS_PORT, useExisting: LimitsService },
        { provide: WalletsService, useValue: mockWalletsService },
        { provide: RequestContextService, useValue: mockRequestContext },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: MetricsService,
          useValue: {
            incrementPaymentsCreated: jest.fn(),
            incrementPaymentsFailed: jest.fn(),
            recordPaymentProcessingDuration: jest.fn(),
            incrementPaymentIdempotencyHit: jest.fn(),
            incrementLimitExceeded: jest.fn(),
            incrementLimitChecks: jest.fn(),
          },
        },
        PaymentMetricsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    paymentsService = moduleRef.get<PaymentsService>(PaymentsService);
    limitsService = moduleRef.get<LimitsService>(LimitsService);
    walletsService = moduleRef.get<WalletsService>(WalletsService);
    prisma = moduleRef.get<PrismaService>(PrismaService);
  });

  describe('Payment Creation', () => {
    it('should create a payment successfully with valid input', async () => {
      const senderWallet = { id: testWalletId, status: WalletStatus.ACTIVE };
      const receiverWallet = { id: testReceiverWalletId, status: WalletStatus.ACTIVE };
      const createdPayment = {
        id: 'payment-1',
        status: PaymentStatus.PENDING,
        amount: 10,
        currency: 'USD',
        fromId: testUserId,
        toId: testReceiverUserId,
      };

      mockWalletsService.findWalletById
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockPrisma.walletLimit.findUnique.mockResolvedValue(null);
      mockPrisma.payment.create.mockResolvedValue(createdPayment);

      const createPaymentDto = {
        walletId: testWalletId,
        receiverWalletId: testReceiverWalletId,
        fromId: testUserId,
        toId: testReceiverUserId,
        amount: 10,
        currency: 'USD',
        description: 'Test payment',
      };

      const payment = await paymentsService.create(createPaymentDto);

      expect(payment).toBeDefined();
      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(payment.amount).toBe(10);
      expect(payment.currency).toBe('USD');
    });

    it('should reject payment from inactive wallet', async () => {
      const inactiveWallet = { id: testWalletId, status: WalletStatus.INACTIVE };

      mockWalletsService.findWalletById.mockResolvedValue(inactiveWallet);

      const createPaymentDto = {
        walletId: testWalletId,
        receiverWalletId: testReceiverWalletId,
        fromId: testUserId,
        toId: testReceiverUserId,
        amount: 10,
        currency: 'USD',
      };

      await expect(
        paymentsService.create(createPaymentDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Limits', () => {
    it('should set wallet limits', async () => {
      const limit = { walletId: testWalletId, dailyLimit: 1000, perTransactionLimit: 500 };

      mockPrisma.walletLimit.upsert.mockResolvedValue(limit);

      const result = await limitsService.setLimits(testWalletId, 1000, 500);

      expect(result).toBeDefined();
      expect(result.walletId).toBe(testWalletId);
      expect(result.dailyLimit).toBe(1000);
      expect(result.perTransactionLimit).toBe(500);
    });

    it('should retrieve wallet limits', async () => {
      const limit = { walletId: testWalletId, dailyLimit: 1000, perTransactionLimit: 500 };

      mockPrisma.walletLimit.findUnique.mockResolvedValue(limit);
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      const result = await limitsService.getLimits(testWalletId);
      expect(result).toBeDefined();
      expect(result.walletId).toBe(testWalletId);
      expect(result.dailyLimit).toBe(1000);
      expect(result.perTransactionLimit).toBe(500);
    });

    it('should return null when no limits are set for wallet', async () => {
      mockPrisma.walletLimit.findUnique.mockResolvedValue(null);

      const result = await limitsService.getLimits(testWalletId);

      expect(result).toBeNull();
    });
  });

  describe('Payment Limit Enforcement', () => {
    it('should reject payment exceeding per-transaction limit', async () => {
      const senderWallet = { id: testWalletId, status: WalletStatus.ACTIVE };
      const receiverWallet = { id: testReceiverWalletId, status: WalletStatus.ACTIVE };
      const limit = { walletId: testWalletId, dailyLimit: 1000, perTransactionLimit: 50 };

      mockWalletsService.findWalletById
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockPrisma.walletLimit.findUnique.mockResolvedValue(limit);
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      const createPaymentDto = {
        walletId: testWalletId,
        receiverWalletId: testReceiverWalletId,
        fromId: testUserId,
        toId: testReceiverUserId,
        amount: 100, // Exceeds per-transaction limit of 50
        currency: 'USD',
      };

      await expect(
        paymentsService.create(createPaymentDto),
      ).rejects.toThrow(LimitExceededException);
    });

    it('should allow payment within per-transaction limit', async () => {
      const senderWallet = { id: testWalletId, status: WalletStatus.ACTIVE };
      const receiverWallet = { id: testReceiverWalletId, status: WalletStatus.ACTIVE };
      const limit = { walletId: testWalletId, dailyLimit: 1000, perTransactionLimit: 500 };
      const createdPayment = {
        id: 'payment-2',
        status: PaymentStatus.PENDING,
        amount: 100,
        currency: 'USD',
        fromId: testUserId,
        toId: testReceiverUserId,
      };

      mockWalletsService.findWalletById
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockPrisma.walletLimit.findUnique.mockResolvedValue(limit);
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.payment.create.mockResolvedValue(createdPayment);

      const createPaymentDto = {
        walletId: testWalletId,
        receiverWalletId: testReceiverWalletId,
        fromId: testUserId,
        toId: testReceiverUserId,
        amount: 100, // Within per-transaction limit of 500
        currency: 'USD',
      };

      const payment = await paymentsService.create(createPaymentDto);

      expect(payment).toBeDefined();
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });

    it('should allow payment when no limits are configured', async () => {
      const senderWallet = { id: testWalletId, status: WalletStatus.ACTIVE };
      const receiverWallet = { id: testReceiverWalletId, status: WalletStatus.ACTIVE };
      const createdPayment = {
        id: 'payment-3',
        status: PaymentStatus.PENDING,
        amount: 100,
        currency: 'USD',
        fromId: testUserId,
        toId: testReceiverUserId,
      };

      mockWalletsService.findWalletById
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockPrisma.walletLimit.findUnique.mockResolvedValue(null);
      mockPrisma.payment.create.mockResolvedValue(createdPayment);

      const createPaymentDto = {
        walletId: testWalletId,
        receiverWalletId: testReceiverWalletId,
        fromId: testUserId,
        toId: testReceiverUserId,
        amount: 100,
        currency: 'USD',
      };

      const payment = await paymentsService.create(createPaymentDto);

      expect(payment).toBeDefined();
      expect(payment.status).toBe(PaymentStatus.PENDING);
    });
  });
});
