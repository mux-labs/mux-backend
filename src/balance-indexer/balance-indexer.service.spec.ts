import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { AssetType, BalanceSyncStatus } from './domain/balance.model';

describe('BalanceIndexerService', () => {
  let service: BalanceIndexerService;
  let mockPrisma: any;

  const mockConfigService = {
    get: jest.fn((key: string, def: any) => {
      if (key === 'BALANCE_STALE_THRESHOLD_MS') return 300000;
      if (key === 'BALANCE_SYNC_INTERVAL_MS') return 600000;
      if (key === 'BALANCE_SYNC_MAX_RETRIES') return 3;
      return def;
    }),
  };

  const mockHorizonService = {
    getAccountBalances: jest.fn(),
    accountExists: jest.fn(),
  };

  beforeEach(async () => {
    mockPrisma = {
      wallet: { findUnique: jest.fn(), findMany: jest.fn() },
      walletBalance: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceIndexerService,
        { provide: StellarHorizonService, useValue: mockHorizonService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<BalanceIndexerService>(BalanceIndexerService);
    // Patch prisma with mock
    (service as any).prisma = mockPrisma;

    jest.clearAllMocks();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── Issue 3: Stale balance detection ───────────────────────────────────────

  describe('detectStaleBalances', () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago

    it('should return stale assets and mark them STALE in DB', async () => {
      mockPrisma.walletBalance.findMany.mockResolvedValue([
        {
          id: 'b1',
          assetType: AssetType.NATIVE,
          assetCode: null,
          lastSyncedAt: staleDate,
          syncStatus: BalanceSyncStatus.SYNCED,
        },
      ]);
      mockPrisma.walletBalance.update.mockResolvedValue({});

      const result = await service.detectStaleBalances('wallet-1');

      expect(result.walletId).toBe('wallet-1');
      expect(result.staleAssets).toContain(AssetType.NATIVE);
      expect(mockPrisma.walletBalance.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { syncStatus: BalanceSyncStatus.STALE },
      });
    });

    it('should return empty stale assets when all balances are fresh', async () => {
      mockPrisma.walletBalance.findMany.mockResolvedValue([
        {
          id: 'b2',
          assetType: AssetType.NATIVE,
          assetCode: null,
          lastSyncedAt: new Date(), // fresh
          syncStatus: BalanceSyncStatus.SYNCED,
        },
      ]);

      const result = await service.detectStaleBalances('wallet-1');
      expect(result.staleAssets).toHaveLength(0);
      expect(mockPrisma.walletBalance.update).not.toHaveBeenCalled();
    });

    it('should treat missing lastSyncedAt as stale', async () => {
      mockPrisma.walletBalance.findMany.mockResolvedValue([
        { id: 'b3', assetType: AssetType.NATIVE, assetCode: null, lastSyncedAt: null },
      ]);
      mockPrisma.walletBalance.update.mockResolvedValue({});

      const result = await service.detectStaleBalances('wallet-1');
      expect(result.staleAssets).toHaveLength(1);
    });
  });

  // ── Issue 1: Retry backoff ─────────────────────────────────────────────────

  describe('syncWalletBalancesWithRetry', () => {
    it('should return result on first successful attempt', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1', publicKey: 'GABC' });
      mockHorizonService.accountExists.mockResolvedValue(true);
      mockHorizonService.getAccountBalances.mockResolvedValue([
        { asset: { type: AssetType.NATIVE }, balance: '100', ledgerSequence: 1, timestamp: new Date() },
      ]);
      mockPrisma.walletBalance.findUnique.mockResolvedValue(null);
      mockPrisma.walletBalance.upsert.mockResolvedValue({});

      const result = await service.syncWalletBalancesWithRetry({ walletId: 'w1' });
      expect(result.walletId).toBe('w1');
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
    });

    it('should retry on failure and succeed', async () => {
      mockPrisma.wallet.findUnique
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce({ id: 'w1', publicKey: 'GABC' });
      mockHorizonService.accountExists.mockResolvedValue(false);
      mockPrisma.walletBalance.upsert.mockResolvedValue({});

      // Override delay to speed up test
      jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });

      const result = await service.syncWalletBalancesWithRetry({ walletId: 'w1' });
      expect(result.walletId).toBe('w1');
    });

    it('should throw after exhausting all retries', async () => {
      mockPrisma.wallet.findUnique.mockRejectedValue(new Error('persistent failure'));
      jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });

      await expect(service.syncWalletBalancesWithRetry({ walletId: 'w1' })).rejects.toThrow(
        'persistent failure',
      );
    });
  });

  // ── Issue 2: Scheduled sync worker ────────────────────────────────────────

  describe('runScheduledSync', () => {
    it('should sync all active wallets', async () => {
      mockPrisma.wallet.findMany.mockResolvedValue([
        { id: 'w1', status: 'ACTIVE', publicKey: 'GABC' },
      ]);
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1', publicKey: 'GABC' });
      mockHorizonService.accountExists.mockResolvedValue(false);
      mockPrisma.walletBalance.upsert.mockResolvedValue({});

      await expect(service.runScheduledSync()).resolves.not.toThrow();
      expect(mockPrisma.wallet.findMany).toHaveBeenCalledWith({ where: { status: 'ACTIVE' } });
    });

    it('should continue when a wallet sync fails', async () => {
      mockPrisma.wallet.findMany.mockResolvedValue([
        { id: 'w1', status: 'ACTIVE' },
        { id: 'w2', status: 'ACTIVE', publicKey: 'GABC' },
      ]);
      // w1 throws NotFoundException, w2 succeeds
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(null) // triggers NotFoundException path
        .mockResolvedValueOnce({ id: 'w2', publicKey: 'GABC' });
      mockHorizonService.accountExists.mockResolvedValue(false);
      mockPrisma.walletBalance.upsert.mockResolvedValue({});

      await expect(service.runScheduledSync()).resolves.not.toThrow();
    });

    it('should not crash when DB query fails', async () => {
      mockPrisma.wallet.findMany.mockRejectedValue(new Error('DB error'));
      await expect(service.runScheduledSync()).resolves.not.toThrow();
    });
  });

  // ── syncWalletBalances (existing behaviour) ────────────────────────────────

  describe('syncWalletBalances', () => {
    it('should set zero balances for non-existent accounts', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'w1', publicKey: 'GABC' });
      mockHorizonService.accountExists.mockResolvedValue(false);
      mockPrisma.walletBalance.upsert.mockResolvedValue({});

      const result = await service.syncWalletBalances({ walletId: 'w1' });
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
      expect(result.balancesUpdated).toBe(1);
    });

    it('should throw NotFoundException for missing wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      await expect(service.syncWalletBalances({ walletId: 'unknown' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
