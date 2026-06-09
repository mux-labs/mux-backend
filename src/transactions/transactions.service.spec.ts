import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceIndexerService } from '../balance-indexer/balance-indexer.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
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

const senderWallet = { id: 'wallet-sender', publicKey: 'GABC', status: 'ACTIVE' };
const receiverWallet = { id: 'wallet-receiver', publicKey: 'GDEF', status: 'ACTIVE' };

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
        { provide: PrismaService, useValue: mockPrisma },
        { provide: BalanceIndexerService, useValue: mockBalanceIndexer },
        { provide: WebhookEventEmitterService, useValue: mockWebhookEmitter },
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

      const result = await service.create({ ...baseDto, idempotencyKey: 'idem-1' });

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
    it('returns all transactions without filters', async () => {
      const txs = [makePrismaTransaction()];
      mockPrisma.transaction.findMany.mockResolvedValue(txs);

      const result = await service.findAll();

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        take: undefined,
        skip: undefined,
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findByWallet', () => {
    it('returns transactions for a valid wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
      mockPrisma.transaction.findMany.mockResolvedValue([makePrismaTransaction()]);

      const result = await service.findByWallet('wallet-1');

      expect(result).toHaveLength(1);
    });

    it('throws NotFoundException when wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.findByWallet('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    it('updates status with valid transition', async () => {
      const existing = makePrismaTransaction({ status: TransactionStatus.PENDING });
      const updated = makePrismaTransaction({ status: TransactionStatus.SUBMITTED });
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
        service.updateStatus('nonexistent', { status: TransactionStatus.SUBMITTED }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid status transition', async () => {
      const existing = makePrismaTransaction({ status: TransactionStatus.CONFIRMED });
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);

      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
    });

    it('emits transaction.pending webhook on SUBMITTED status', async () => {
      const existing = makePrismaTransaction({ status: TransactionStatus.PENDING });
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
});
