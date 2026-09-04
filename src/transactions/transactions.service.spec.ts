import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceIndexerService } from '../balance-indexer/balance-indexer.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { CacheService } from '../common/cache/cache.service';
import { TransactionMetricsService } from './transaction-metrics.service';
import { TransactionStatus } from './domain/transaction.model';
import { InsufficientBalanceException } from './domain/insufficient-balance.exception';
import { AssetType } from '../balance-indexer/domain/balance.model';

const mockDate = new Date('2024-01-01T00:00:00.000Z');

const makePrismaTransaction = (overrides: Partial<any> = {}) => ({
  id: 'tx-1',
  amount: '100',
  assetType: 'NATIVE',
  assetCode: null,
  assetIssuer: null,
  senderWalletId: 'wallet-sender',
  receiverWalletId: 'wallet-receiver',
  status: TransactionStatus.PENDING,
  stellarHash: null,
  stellarLedger: null,
  stellarFee: null,
  statusChangedAt: mockDate,
  statusReason: null,
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
  metadata: null,
  idempotencyKey: null,
  createdAt: mockDate,
  updatedAt: mockDate,
  ...overrides,
});

const mockPrisma = {
  wallet: { findUnique: jest.fn() },
  transaction: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
};

const mockBalanceIndexer = {
  getBalance: jest.fn(),
};

const mockWebhookEmitter = {
  emitTransactionCreated: jest.fn().mockResolvedValue(undefined),
  emitTransactionPending: jest.fn().mockResolvedValue(undefined),
  emitTransactionConfirmed: jest.fn().mockResolvedValue(undefined),
  emitTransactionFailed: jest.fn().mockResolvedValue(undefined),
};

const mockMetrics = {
  incrementTransactionCreated: jest.fn(),
  incrementStatusUpdated: jest.fn(),
  incrementIdempotencyHit: jest.fn(),
  incrementCacheHit: jest.fn(),
  incrementCacheMiss: jest.fn(),
  getSnapshot: jest.fn(),
};

const senderWallet = {
  id: 'wallet-sender',
  publicKey: 'GABC',
  status: 'ACTIVE',
};
const receiverWallet = {
  id: 'wallet-receiver',
  publicKey: 'GDEF',
  status: 'ACTIVE',
};

const baseDto = {
  amount: '10',
  asset: { type: AssetType.NATIVE },
  senderWalletId: 'wallet-sender',
  receiverWalletId: 'wallet-receiver',
};

describe('TransactionsService', () => {
  let service: TransactionsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        CacheService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BalanceIndexerService, useValue: mockBalanceIndexer },
        { provide: WebhookEventEmitterService, useValue: mockWebhookEmitter },
        { provide: TransactionMetricsService, useValue: mockMetrics },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('creates a transaction when balance is sufficient', async () => {
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '100' });
      mockPrisma.transaction.create.mockResolvedValue(makePrismaTransaction());

      const result = await service.create(baseDto);

      expect(result.id).toBe('tx-1');
      expect(result.status).toBe(TransactionStatus.PENDING);
      expect(mockPrisma.transaction.create).toHaveBeenCalledTimes(1);
    });

    it('throws InsufficientBalanceException when balance is less than amount', async () => {
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '5' });

      await expect(service.create(baseDto)).rejects.toThrow(
        InsufficientBalanceException,
      );
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when sender wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValueOnce(null);

      await expect(service.create(baseDto)).rejects.toThrow(NotFoundException);
      expect(mockBalanceIndexer.getBalance).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when receiver wallet does not exist', async () => {
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(null);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '100' });

      await expect(service.create(baseDto)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('returns existing transaction on idempotency key hit', async () => {
      const existing = makePrismaTransaction({ idempotencyKey: 'idem-1' });
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);

      const result = await service.create({
        ...baseDto,
        idempotencyKey: 'idem-1',
      });

      expect(result.id).toBe('tx-1');
      expect(mockPrisma.wallet.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('emits transaction.created webhook after creation', async () => {
      const created = makePrismaTransaction();
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '100' });
      mockPrisma.transaction.create.mockResolvedValue(created);

      await service.create(baseDto);
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionCreated).toHaveBeenCalledWith({
        transactionId: created.id,
        walletId: created.senderWalletId,
        amount: created.amount,
        asset: created.assetType,
        destination: created.receiverWalletId,
      });
    });
  });

  describe('findAll', () => {
    it('returns paginated transactions without filters', async () => {
      const txs = [makePrismaTransaction()];
      mockPrisma.transaction.findMany.mockResolvedValue(txs);
      mockPrisma.transaction.count.mockResolvedValue(1);

      const result = await service.findAll();

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        take: 20,
        skip: 0,
      });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('uses provided limit and offset', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transaction.count.mockResolvedValue(10);

      const result = await service.findAll({ limit: 5, offset: 5 });

      expect(result.limit).toBe(5);
      expect(result.offset).toBe(5);
      expect(result.hasMore).toBe(false);
    });

    it('sets hasMore=true when more results exist', async () => {
      const txs = [makePrismaTransaction()];
      mockPrisma.transaction.findMany.mockResolvedValue(txs);
      mockPrisma.transaction.count.mockResolvedValue(5);

      const result = await service.findAll({ limit: 1, offset: 0 });

      expect(result.hasMore).toBe(true);
    });

    it('filters by assetType', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ assetType: 'CREDIT_ALPHANUM4' });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ assetType: 'CREDIT_ALPHANUM4' }),
        }),
      );
    });

    it('filters by assetCode', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ assetCode: 'USDC' });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ assetCode: 'USDC' }),
        }),
      );
    });

    it('filters by minAmount and maxAmount', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ minAmount: '10', maxAmount: '500' });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            amount: { gte: '10', lte: '500' },
          }),
        }),
      );
    });

    it('filters by minAmount only', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ minAmount: '50' });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ amount: { gte: '50' } }),
        }),
      );
    });

    it('filters by createdAfter and createdBefore', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      const after = new Date('2024-01-01T00:00:00.000Z');
      const before = new Date('2024-12-31T23:59:59.999Z');

      await service.findAll({ createdAfter: after, createdBefore: before });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: after, lte: before },
          }),
        }),
      );
    });

    it('filters by createdAfter only', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      const after = new Date('2024-06-01T00:00:00.000Z');

      await service.findAll({ createdAfter: after });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: after },
          }),
        }),
      );
    });
  });

  describe('findByWallet', () => {
    it('returns paginated transactions for a valid wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
      mockPrisma.transaction.findMany.mockResolvedValue([
        makePrismaTransaction(),
      ]);
      mockPrisma.transaction.count.mockResolvedValue(1);

      const result = await service.findByWallet('wallet-1');

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it('throws NotFoundException when wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.findByWallet('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findOne', () => {
    it('retrieves transaction from database when not cached', async () => {
      const tx = makePrismaTransaction();
      mockPrisma.transaction.findUnique.mockResolvedValue(tx);

      const result = await service.findOne('tx-1');

      expect(result.id).toBe('tx-1');
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(1);
    });

    it('retrieves transaction from cache on subsequent calls', async () => {
      const tx = makePrismaTransaction();
      mockPrisma.transaction.findUnique.mockResolvedValue(tx);

      // First call - should hit database
      const result1 = await service.findOne('tx-1');
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(1);

      // Second call - should hit cache
      const result2 = await service.findOne('tx-1');
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(1); // Still 1, not 2
      expect(result2).toEqual(result1);
    });

    it('throws NotFoundException when transaction does not exist', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    it('updates status with valid transition', async () => {
      const existing = makePrismaTransaction({
        status: TransactionStatus.PENDING,
      });
      const updated = makePrismaTransaction({
        status: TransactionStatus.SUBMITTED,
      });
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);
      mockPrisma.transaction.update.mockResolvedValue(updated);

      const result = await service.updateStatus('tx-1', {
        status: TransactionStatus.SUBMITTED,
      });

      expect(result.status).toBe(TransactionStatus.SUBMITTED);
    });

    it('throws NotFoundException when transaction does not exist', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('nonexistent', {
          status: TransactionStatus.SUBMITTED,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid status transition', async () => {
      const existing = makePrismaTransaction({
        status: TransactionStatus.CONFIRMED,
      });
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);

      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
    });

    it('invalidates cache when transaction is updated', async () => {
      const existing = makePrismaTransaction({
        status: TransactionStatus.PENDING,
      });
      const tx = makePrismaTransaction();
      const updated = makePrismaTransaction({
        status: TransactionStatus.SUBMITTED,
      });

      // Populate cache by calling findOne
      mockPrisma.transaction.findUnique.mockResolvedValueOnce(tx);
      await service.findOne('tx-1');
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(1);

      // Update status
      mockPrisma.transaction.findUnique.mockResolvedValueOnce(existing);
      mockPrisma.transaction.update.mockResolvedValue(updated);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.SUBMITTED,
      });

      // Cache should be invalidated, so the next findOne must hit the database again
      mockPrisma.transaction.findUnique.mockResolvedValueOnce(updated);
      await service.findOne('tx-1');
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(3);
    });

    it('emits transaction.pending webhook on SUBMITTED status', async () => {
      const existing = makePrismaTransaction({
        status: TransactionStatus.PENDING,
      });
      const submitted = {
        ...existing,
        status: TransactionStatus.SUBMITTED,
        stellarHash: 'hash-abc',
      };
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);
      mockPrisma.transaction.update.mockResolvedValue(submitted);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.SUBMITTED,
        stellarHash: 'hash-abc',
      });
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionPending).toHaveBeenCalledWith({
        transactionId: 'tx-1',
        walletId: existing.senderWalletId,
        txHash: 'hash-abc',
      });
    });
  });

  describe('domain event emission', () => {
    it('does not throw when webhookEventEmitter is absent (fire-and-forget)', async () => {
      const moduleWithoutEmitter: TestingModule =
        await Test.createTestingModule({
          providers: [
            TransactionsService,
            CacheService,
            { provide: PrismaService, useValue: mockPrisma },
            { provide: BalanceIndexerService, useValue: mockBalanceIndexer },
          ],
        }).compile();

      const svc =
        moduleWithoutEmitter.get<TransactionsService>(TransactionsService);

      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '100' });
      mockPrisma.transaction.create.mockResolvedValue(makePrismaTransaction());

      await expect(svc.create(baseDto)).resolves.toBeDefined();
    });

    it('logs a warning and does not throw when domain event emission fails', async () => {
      const existing = makePrismaTransaction({
        status: TransactionStatus.PENDING,
      });
      const submitted = {
        ...existing,
        status: TransactionStatus.SUBMITTED,
        stellarHash: 'hash-fail',
      };
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);
      mockPrisma.transaction.update.mockResolvedValue(submitted);
      mockWebhookEmitter.emitTransactionPending.mockRejectedValueOnce(
        new Error('network error'),
      );

      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.SUBMITTED }),
      ).resolves.toBeDefined();
    });

    it('emits transaction.confirmed domain event on CONFIRMED status', async () => {
      const existing = makePrismaTransaction({
        status: TransactionStatus.SUBMITTED,
      });
      const confirmed = {
        ...existing,
        status: TransactionStatus.CONFIRMED,
        stellarHash: 'hash-confirm',
        stellarLedger: 42,
      };
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);
      mockPrisma.transaction.update.mockResolvedValue(confirmed);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.CONFIRMED,
      });
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionConfirmed).toHaveBeenCalledWith({
        transactionId: 'tx-1',
        walletId: existing.senderWalletId,
        txHash: 'hash-confirm',
        ledger: 42,
        confirmations: 1,
      });
    });

    it('emits transaction.failed domain event on FAILED status', async () => {
      const existing = makePrismaTransaction({
        status: TransactionStatus.PENDING,
      });
      const failed = {
        ...existing,
        status: TransactionStatus.FAILED,
        statusReason: 'timeout',
      };
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);
      mockPrisma.transaction.update.mockResolvedValue(failed);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.FAILED,
        statusReason: 'timeout',
      });
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionFailed).toHaveBeenCalledWith({
        transactionId: 'tx-1',
        walletId: existing.senderWalletId,
        reason: 'timeout',
      });
    });
  });
});
