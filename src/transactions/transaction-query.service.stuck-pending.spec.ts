import { Test, TestingModule } from '@nestjs/testing';
import { TransactionQueryService } from './transaction-query.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache/cache.service';
import { TransactionStatus } from './domain/transaction.model';

describe('TransactionQueryService - findStuckPendingTransactions', () => {
  let service: TransactionQueryService;
  let mockPrisma: any;
  let mockCache: any;

  beforeEach(async () => {
    mockPrisma = {
      transaction: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    mockCache = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionQueryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<TransactionQueryService>(TransactionQueryService);
  });

  it('should return stuck transactions pending longer than threshold', async () => {
    const now = new Date();
    const oldTx = {
      id: 'tx-old-1',
      amount: '100',
      assetType: 'NATIVE',
      assetCode: null,
      assetIssuer: null,
      senderWalletId: 'wallet-1',
      receiverWalletId: 'wallet-2',
      memo: null,
      status: TransactionStatus.PENDING,
      stellarHash: null,
      stellarLedger: null,
      stellarFee: null,
      statusChangedAt: new Date(now.getTime() - 120 * 60 * 1000), // 2 hours ago
      statusReason: null,
      submittedAt: null,
      confirmedAt: null,
      failedAt: null,
      metadata: null,
      idempotencyKey: null,
      createdAt: new Date(now.getTime() - 120 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 120 * 60 * 1000),
    };

    mockPrisma.transaction.findMany.mockResolvedValue([oldTx]);
    mockPrisma.transaction.count.mockResolvedValue(1);

    const result = await service.findStuckPendingTransactions(60, 100, 0);

    expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith({
      where: {
        status: TransactionStatus.PENDING,
        createdAt: { lt: expect.any(Date) },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      skip: 0,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('tx-old-1');
    expect(result.total).toBe(1);
  });

  it('should exclude transactions created within threshold', async () => {
    const now = new Date();
    const recentTx = {
      id: 'tx-recent-1',
      amount: '50',
      assetType: 'NATIVE',
      assetCode: null,
      assetIssuer: null,
      senderWalletId: 'wallet-1',
      receiverWalletId: 'wallet-2',
      memo: null,
      status: TransactionStatus.PENDING,
      stellarHash: null,
      stellarLedger: null,
      stellarFee: null,
      statusChangedAt: new Date(now.getTime() - 10 * 60 * 1000), // 10 minutes ago
      statusReason: null,
      submittedAt: null,
      confirmedAt: null,
      failedAt: null,
      metadata: null,
      idempotencyKey: null,
      createdAt: new Date(now.getTime() - 10 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
    };

    mockPrisma.transaction.findMany.mockResolvedValue([]);
    mockPrisma.transaction.count.mockResolvedValue(0);

    const result = await service.findStuckPendingTransactions(60, 100, 0);

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('should respect pagination parameters', async () => {
    mockPrisma.transaction.findMany.mockResolvedValue([]);
    mockPrisma.transaction.count.mockResolvedValue(500);

    await service.findStuckPendingTransactions(120, 50, 100);

    expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith({
      where: {
        status: TransactionStatus.PENDING,
        createdAt: { lt: expect.any(Date) },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      skip: 100,
    });
  });

  it('should sort results by createdAt ascending (oldest first)', async () => {
    const now = new Date();
    const tx1 = { id: 'tx-1', createdAt: new Date(now.getTime() - 120 * 60 * 1000) };
    const tx2 = { id: 'tx-2', createdAt: new Date(now.getTime() - 60 * 60 * 1000) };

    mockPrisma.transaction.findMany.mockResolvedValue([tx1, tx2]);
    mockPrisma.transaction.count.mockResolvedValue(2);

    await service.findStuckPendingTransactions(30, 100, 0);

    expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('should use custom threshold minutes', async () => {
    mockPrisma.transaction.findMany.mockResolvedValue([]);
    mockPrisma.transaction.count.mockResolvedValue(0);

    await service.findStuckPendingTransactions(240, 100, 0);

    expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: TransactionStatus.PENDING,
          createdAt: { lt: expect.any(Date) },
        }),
      }),
    );
  });

  it('should return total count separate from data', async () => {
    const tx = { id: 'tx-1' };
    mockPrisma.transaction.findMany.mockResolvedValue([tx]);
    mockPrisma.transaction.count.mockResolvedValue(250);

    const result = await service.findStuckPendingTransactions(60, 1, 0);

    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('total');
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(250);
  });
});
