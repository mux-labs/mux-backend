import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { TransactionStatus } from './domain/transaction.model';

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({})),
}));

const mockPrisma = {
  wallet: { findUnique: jest.fn() },
  transaction: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

const mockWebhookEmitter = {
  emitTransactionCreated: jest.fn().mockResolvedValue(undefined),
  emitTransactionPending: jest.fn().mockResolvedValue(undefined),
  emitTransactionConfirmed: jest.fn().mockResolvedValue(undefined),
  emitTransactionFailed: jest.fn().mockResolvedValue(undefined),
};

const baseTx = {
  id: 'tx-1',
  amount: '100',
  assetType: 'NATIVE',
  assetCode: null,
  assetIssuer: null,
  senderWalletId: 'wallet-1',
  receiverWalletId: 'wallet-2',
  status: TransactionStatus.PENDING,
  stellarHash: null,
  stellarLedger: null,
  stellarFee: null,
  statusChangedAt: new Date(),
  statusReason: null,
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('TransactionsService', () => {
  let service: TransactionsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WebhookEventEmitterService, useValue: mockWebhookEmitter },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const dto = {
      amount: '100',
      asset: { type: 'NATIVE' },
      senderWalletId: 'wallet-1',
      receiverWalletId: 'wallet-2',
    };

    beforeEach(() => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
      mockPrisma.transaction.create.mockResolvedValue(baseTx);
    });

    it('should emit transaction.created webhook after creation', async () => {
      await service.create(dto);

      // Allow the fire-and-forget promise to settle
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionCreated).toHaveBeenCalledWith({
        transactionId: baseTx.id,
        walletId: baseTx.senderWalletId,
        amount: baseTx.amount,
        asset: baseTx.assetType,
        destination: baseTx.receiverWalletId,
      });
    });

    it('should not throw if webhook emit fails', async () => {
      mockWebhookEmitter.emitTransactionCreated.mockRejectedValueOnce(
        new Error('dispatch error'),
      );

      await expect(service.create(dto)).resolves.toBeDefined();
    });

    it('should throw NotFoundException when sender wallet not found', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    beforeEach(() => {
      mockPrisma.transaction.findUnique.mockResolvedValue(baseTx);
    });

    it('should emit transaction.pending webhook on SUBMITTED status', async () => {
      const submitted = {
        ...baseTx,
        status: TransactionStatus.SUBMITTED,
        stellarHash: 'hash-abc',
      };
      mockPrisma.transaction.update.mockResolvedValue(submitted);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.SUBMITTED,
        stellarHash: 'hash-abc',
      });
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionPending).toHaveBeenCalledWith({
        transactionId: 'tx-1',
        walletId: baseTx.senderWalletId,
        txHash: 'hash-abc',
      });
    });

    it('should emit transaction.confirmed webhook on CONFIRMED status', async () => {
      const pending = { ...baseTx, status: TransactionStatus.SUBMITTED };
      mockPrisma.transaction.findUnique.mockResolvedValue(pending);
      const confirmed = {
        ...pending,
        status: TransactionStatus.CONFIRMED,
        stellarHash: 'hash-abc',
        stellarLedger: 42,
      };
      mockPrisma.transaction.update.mockResolvedValue(confirmed);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.CONFIRMED,
      });
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionConfirmed).toHaveBeenCalledWith({
        transactionId: 'tx-1',
        walletId: pending.senderWalletId,
        txHash: 'hash-abc',
        ledger: 42,
        confirmations: 1,
      });
    });

    it('should emit transaction.failed webhook on FAILED status', async () => {
      const failed = {
        ...baseTx,
        status: TransactionStatus.FAILED,
        statusReason: 'insufficient funds',
      };
      mockPrisma.transaction.update.mockResolvedValue(failed);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.FAILED,
        statusReason: 'insufficient funds',
      });
      await Promise.resolve();

      expect(mockWebhookEmitter.emitTransactionFailed).toHaveBeenCalledWith({
        transactionId: 'tx-1',
        walletId: baseTx.senderWalletId,
        reason: 'insufficient funds',
      });
    });

    it('should not throw if webhook emit fails on status update', async () => {
      mockWebhookEmitter.emitTransactionPending.mockRejectedValueOnce(
        new Error('dispatch error'),
      );
      const submitted = { ...baseTx, status: TransactionStatus.SUBMITTED };
      mockPrisma.transaction.update.mockResolvedValue(submitted);

      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.SUBMITTED }),
      ).resolves.toBeDefined();
    });

    it('should throw BadRequestException for invalid status transition', async () => {
      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.CONFIRMED }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when transaction not found', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);
      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.SUBMITTED }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
