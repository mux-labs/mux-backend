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
    });
  });
});
