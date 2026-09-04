import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TransactionQueryService } from './transaction-query.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache/cache.service';
import { TransactionStatus } from './domain/transaction.model';

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
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
};

describe('TransactionQueryService', () => {
  let service: TransactionQueryService;
  let cacheService: CacheService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionQueryService,
        CacheService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TransactionQueryService>(TransactionQueryService);
    cacheService = module.get<CacheService>(CacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
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
      expect(result[0].id).toBe('tx-1');
    });

    it('applies senderWalletId filter', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ senderWalletId: 'wallet-sender' });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { senderWalletId: 'wallet-sender' },
        }),
      );
    });

    it('applies status filter', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ status: TransactionStatus.PENDING });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: TransactionStatus.PENDING },
        }),
      );
    });

    it('applies pagination', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ limit: 5, offset: 10 });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 10 }),
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

      await service.findOne('tx-1');
      const result2 = await service.findOne('tx-1');

      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(1);
      expect(result2.id).toBe('tx-1');
    });

    it('throws NotFoundException when transaction does not exist', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByWallet', () => {
    it('returns transactions for a valid wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
      mockPrisma.transaction.findMany.mockResolvedValue([
        makePrismaTransaction(),
      ]);

      const result = await service.findByWallet('wallet-1');

      expect(result).toHaveLength(1);
      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { senderWalletId: 'wallet-1' },
              { receiverWalletId: 'wallet-1' },
            ],
          },
        }),
      );
    });

    it('throws NotFoundException when wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.findByWallet('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findByStellarHash', () => {
    it('returns transaction when stellar hash matches', async () => {
      const tx = makePrismaTransaction({ stellarHash: 'abc123' });
      mockPrisma.transaction.findUnique.mockResolvedValue(tx);

      const result = await service.findByStellarHash('abc123');

      expect(result).not.toBeNull();
      expect(result!.stellarHash).toBe('abc123');
    });

    it('returns null when no transaction matches the hash', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      const result = await service.findByStellarHash('unknown-hash');

      expect(result).toBeNull();
    });
  });

  describe('invalidateCache', () => {
    it('removes the cached entry so the next findOne hits the database', async () => {
      const tx = makePrismaTransaction();
      mockPrisma.transaction.findUnique.mockResolvedValue(tx);

      // Populate cache
      await service.findOne('tx-1');
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(1);

      // Invalidate
      service.invalidateCache('tx-1');

      // Next call must hit database again
      mockPrisma.transaction.findUnique.mockResolvedValue(tx);
      await service.findOne('tx-1');
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledTimes(2);
    });
  });
});
