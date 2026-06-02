// Mock the generated Prisma client before any imports that depend on it
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceIndexerService } from '../balance-indexer/balance-indexer.service';
import { TransactionStatus } from './domain/transaction.model';
import { InsufficientBalanceException } from './domain/insufficient-balance.exception';
import { AssetType } from '../balance-indexer/domain/balance.model';

const mockPrisma = {
  wallet: { findUnique: jest.fn() },
  transaction: { create: jest.fn() },
};

const mockBalanceIndexer = {
  getBalance: jest.fn(),
};

const senderWallet = { id: 'wallet-sender', publicKey: 'GABC', status: 'ACTIVE' };
const receiverWallet = { id: 'wallet-receiver', publicKey: 'GDEF', status: 'ACTIVE' };

const baseDto = {
  amount: '10',
  asset: { type: AssetType.NATIVE },
  senderWalletId: 'wallet-sender',
  receiverWalletId: 'wallet-receiver',
};

const createdTx = {
  id: 'tx-1',
  amount: '10',
  assetType: AssetType.NATIVE,
  assetCode: null,
  assetIssuer: null,
  senderWalletId: 'wallet-sender',
  receiverWalletId: 'wallet-receiver',
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
        { provide: BalanceIndexerService, useValue: mockBalanceIndexer },
        { provide: WebhookEventEmitterService, useValue: mockWebhookEmitter },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  describe('create', () => {
    it('creates a transaction when balance is sufficient', async () => {
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '100' });
      mockPrisma.transaction.create.mockResolvedValue(createdTx);

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

    it('throws InsufficientBalanceException when no balance record exists (treats as 0)', async () => {
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue(null);

      await expect(service.create(baseDto)).rejects.toThrow(
        InsufficientBalanceException,
      );
      expect(mockPrisma.transaction.create).not.toHaveBeenCalled();
    });

    it('allows transaction when balance exactly equals amount', async () => {
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '10' });
      mockPrisma.transaction.create.mockResolvedValue(createdTx);

      const result = await service.create(baseDto);
      expect(result.id).toBe('tx-1');
    });

    it('includes asset code in the exception message for non-native assets', async () => {
      const dto = {
        ...baseDto,
        asset: { type: AssetType.CREDIT_ALPHANUM4, code: 'USDC', issuer: 'GISSUER' },
      };
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(senderWallet)
        .mockResolvedValueOnce(receiverWallet);
      mockBalanceIndexer.getBalance.mockResolvedValue({ balance: '1' });

      await expect(service.create(dto)).rejects.toThrow(/USDC/);
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
