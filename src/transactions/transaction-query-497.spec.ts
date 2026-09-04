/**
 * Tests for:
 *   #497 – Filter transactions by status and wallet (extended filters)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import {
  TransactionQueryService,
  TransactionFilters,
} from './transaction-query.service';
import { TransactionStatus } from './domain/transaction.model';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache/cache.service';

// ─── Prisma / Cache mocks ────────────────────────────────────────────────────

const mockTransaction = {
  findMany: jest.fn(),
  count: jest.fn(),
  findUnique: jest.fn(),
};

const mockWallet = {
  findUnique: jest.fn(),
};

const mockPrismaService = {
  transaction: mockTransaction,
  wallet: mockWallet,
};

const mockCacheService = {
  get: jest.fn().mockReturnValue(null),
  set: jest.fn(),
  delete: jest.fn(),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const buildTx = (overrides: Partial<any> = {}) => ({
  id: 'tx-1',
  amount: '10',
  assetType: 'NATIVE',
  assetCode: null,
  assetIssuer: null,
  senderWalletId: 'w-sender',
  receiverWalletId: 'w-receiver',
  memo: null,
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
  idempotencyKey: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('TransactionQueryService – #497 Extended Filters', () => {
  let service: TransactionQueryService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionQueryService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<TransactionQueryService>(TransactionQueryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── Basic filter pass-through ─────────────────────────────────────────────

  it('finds all transactions with no filters', async () => {
    mockTransaction.findMany.mockResolvedValue([buildTx()]);
    mockTransaction.count.mockResolvedValue(1);

    const result = await service.findAll();

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('filters by senderWalletId', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ senderWalletId: 'w-sender' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ senderWalletId: 'w-sender' }),
      }),
    );
  });

  it('filters by receiverWalletId', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ receiverWalletId: 'w-receiver' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ receiverWalletId: 'w-receiver' }),
      }),
    );
  });

  it('filters by status', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ status: TransactionStatus.CONFIRMED });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: TransactionStatus.CONFIRMED }),
      }),
    );
  });

  // ── #497: Asset filters ───────────────────────────────────────────────────

  it('filters by assetType', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ assetType: 'CREDIT_ALPHANUM4' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assetType: 'CREDIT_ALPHANUM4' }),
      }),
    );
  });

  it('filters by assetCode', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ assetCode: 'USDC' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assetCode: 'USDC' }),
      }),
    );
  });

  it('filters by both assetType and assetCode together', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ assetType: 'CREDIT_ALPHANUM4', assetCode: 'USDC' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assetType: 'CREDIT_ALPHANUM4',
          assetCode: 'USDC',
        }),
      }),
    );
  });

  // ── #497: Amount range filters ────────────────────────────────────────────

  it('applies minAmount filter', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ minAmount: '5' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ amount: { gte: '5' } }),
      }),
    );
  });

  it('applies maxAmount filter', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ maxAmount: '100' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ amount: { lte: '100' } }),
      }),
    );
  });

  it('applies both minAmount and maxAmount as a range', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ minAmount: '5', maxAmount: '100' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ amount: { gte: '5', lte: '100' } }),
      }),
    );
  });

  // ── #497: Date range filters ──────────────────────────────────────────────

  it('applies createdAfter filter', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    const after = new Date('2026-01-01T00:00:00Z');
    await service.findAll({ createdAfter: after });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: after } }),
      }),
    );
  });

  it('applies createdBefore filter', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    const before = new Date('2026-12-31T23:59:59Z');
    await service.findAll({ createdBefore: before });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { lte: before } }),
      }),
    );
  });

  it('applies both createdAfter and createdBefore as a range', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    const after = new Date('2026-01-01T00:00:00Z');
    const before = new Date('2026-12-31T23:59:59Z');
    await service.findAll({ createdAfter: after, createdBefore: before });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: after, lte: before },
        }),
      }),
    );
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('returns correct pagination metadata when there are more pages', async () => {
    const txs = Array.from({ length: 10 }, (_, i) => buildTx({ id: `tx-${i}` }));
    mockTransaction.findMany.mockResolvedValue(txs);
    mockTransaction.count.mockResolvedValue(50);

    const result = await service.findAll({ limit: 10, offset: 0 });

    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
    expect(result.total).toBe(50);
    expect(result.hasMore).toBe(true);
  });

  it('hasMore is false on the last page', async () => {
    const txs = Array.from({ length: 3 }, (_, i) => buildTx({ id: `tx-${i}` }));
    mockTransaction.findMany.mockResolvedValue(txs);
    mockTransaction.count.mockResolvedValue(13);

    const result = await service.findAll({ limit: 10, offset: 10 });

    expect(result.hasMore).toBe(false); // 10 + 3 = 13 = total
  });

  // ── Memo filter ───────────────────────────────────────────────────────────

  it('performs case-insensitive memo substring search', async () => {
    mockTransaction.findMany.mockResolvedValue([]);
    mockTransaction.count.mockResolvedValue(0);

    await service.findAll({ memo: 'invoice' });

    expect(mockTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memo: { contains: 'invoice', mode: 'insensitive' },
        }),
      }),
    );
  });

  // ── findOne ──────────────────────────────────────────────────────────────

  it('findOne throws NotFoundException when transaction does not exist', async () => {
    mockTransaction.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing-id')).rejects.toThrow(NotFoundException);
  });

  it('findOne returns cached entity on cache hit', async () => {
    const tx = buildTx();
    mockCacheService.get.mockReturnValueOnce(tx);

    const result = await service.findOne('tx-1');

    expect(result).toBe(tx);
    expect(mockTransaction.findUnique).not.toHaveBeenCalled();
  });
});
