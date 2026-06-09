import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssetType, BalanceSyncStatus } from './domain/balance.model';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';

const WALLET_ID = 'wallet-123';
const PUBLIC_KEY = 'GABC123';

const nativeAsset = { type: AssetType.NATIVE };
const nativeBalance = {
  id: 'bal-1',
  walletId: WALLET_ID,
  assetType: AssetType.NATIVE,
  assetCode: null,
  assetIssuer: null,
  balance: '100.0000000',
  syncStatus: BalanceSyncStatus.SYNCED,
  lastSyncedAt: new Date(),
  lastSyncedLedger: 1000,
  lastReconciledAt: null,
  reconciliationAttempts: 0,
  onChainBalance: '100.0000000',
  mismatchDetectedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeBalanceUpdate = (balance = '100.0000000') => ({
  walletId: WALLET_ID,
  asset: nativeAsset,
  balance,
  ledgerSequence: 1000,
  timestamp: new Date(),
});

describe('BalanceIndexerService', () => {
  let service: BalanceIndexerService;
  let prisma: jest.Mocked<PrismaService>;
  let horizonService: jest.Mocked<StellarHorizonService>;

  const mockPrisma = {
    walletBalance: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    balanceSyncJob: {
      create: jest.fn().mockResolvedValue({ id: 'job-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  const mockHorizon = {
    getAccountBalances: jest.fn(),
    accountExists: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn().mockReturnValue(300_000),
  };

  const mockWebhookEmitter = {
    emitBalanceUpdated: jest.fn().mockResolvedValue(undefined),
    emitBalanceMismatch: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceIndexerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarHorizonService, useValue: mockHorizon },
        { provide: ConfigService, useValue: mockConfig },
        { provide: WebhookEventEmitterService, useValue: mockWebhookEmitter },
      ],
    }).compile();

    service = module.get<BalanceIndexerService>(BalanceIndexerService);
    prisma = module.get(PrismaService);
    horizonService = module.get(StellarHorizonService);

    mockPrisma.balanceSyncJob.create.mockResolvedValue({ id: 'job-1' });
    mockPrisma.balanceSyncJob.update.mockResolvedValue({});
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── getBalance ──────────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('returns null when balance record does not exist', async () => {
      mockPrisma.walletBalance.findUnique.mockResolvedValue(null);
      const result = await service.getBalance(WALLET_ID, nativeAsset);
      expect(result).toBeNull();
    });

    it('returns mapped balance when found', async () => {
      mockPrisma.walletBalance.findUnique.mockResolvedValue(nativeBalance);
      const result = await service.getBalance(WALLET_ID, nativeAsset);
      expect(result).toMatchObject({
        walletId: WALLET_ID,
        balance: '100.0000000',
        assetType: AssetType.NATIVE,
      });
    });

    it('triggers background refresh when balance is stale', async () => {
      const staleBalance = {
        ...nativeBalance,
        lastSyncedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      };
      mockPrisma.walletBalance.findUnique.mockResolvedValue(staleBalance);
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
      });
      mockHorizon.accountExists.mockResolvedValue(true);
      mockHorizon.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      mockPrisma.walletBalance.upsert.mockResolvedValue(nativeBalance);

      const syncSpy = jest.spyOn(service, 'syncWalletBalances');
      await service.getBalance(WALLET_ID, nativeAsset);

      // Async — give the microtask queue a tick
      await new Promise(process.nextTick);
      expect(syncSpy).toHaveBeenCalledWith({ walletId: WALLET_ID });
    });

    it('does not trigger refresh when balance is fresh', async () => {
      mockPrisma.walletBalance.findUnique.mockResolvedValue(nativeBalance); // lastSyncedAt = now
      const syncSpy = jest.spyOn(service, 'syncWalletBalances');
      await service.getBalance(WALLET_ID, nativeAsset);
      await new Promise(process.nextTick);
      expect(syncSpy).not.toHaveBeenCalled();
    });
  });

  // ─── getAllBalances ───────────────────────────────────────────────────────────

  describe('getAllBalances', () => {
    it('returns empty array when no balances exist', async () => {
      mockPrisma.walletBalance.findMany.mockResolvedValue([]);
      const result = await service.getAllBalances(WALLET_ID);
      expect(result).toEqual([]);
    });

    it('returns all balances for a wallet', async () => {
      mockPrisma.walletBalance.findMany.mockResolvedValue([nativeBalance]);
      const result = await service.getAllBalances(WALLET_ID);
      expect(result).toHaveLength(1);
      expect(result[0].balance).toBe('100.0000000');
    });
  });

  // ─── syncWalletBalances ───────────────────────────────────────────────────────

  describe('syncWalletBalances', () => {
    it('throws NotFoundException when wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.syncWalletBalances({ walletId: WALLET_ID }),
      ).rejects.toThrow('Balance sync failed');
    });

    it('sets zero balances when account does not exist on-chain', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
      });
      mockHorizon.accountExists.mockResolvedValue(false);
      mockPrisma.walletBalance.upsert.mockResolvedValue(nativeBalance);

      const result = await service.syncWalletBalances({ walletId: WALLET_ID });

      expect(result.balancesUpdated).toBe(1);
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
      expect(mockPrisma.walletBalance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ balance: '0' }),
        }),
      );
    });

    it('syncs balances from Horizon when account exists', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
      });
      mockHorizon.accountExists.mockResolvedValue(true);
      mockHorizon.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      mockPrisma.walletBalance.findUnique.mockResolvedValue(null);
      mockPrisma.walletBalance.upsert.mockResolvedValue(nativeBalance);

      const result = await service.syncWalletBalances({ walletId: WALLET_ID });

      expect(result.balancesUpdated).toBe(1);
      expect(result.mismatchesFound).toBe(0);
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
    });

    it('detects mismatches when existing balance differs', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
      });
      mockHorizon.accountExists.mockResolvedValue(true);
      mockHorizon.getAccountBalances.mockResolvedValue([
        makeBalanceUpdate('200.0000000'),
      ]);
      // existing balance is different → mismatch
      mockPrisma.walletBalance.findUnique.mockResolvedValue({
        ...nativeBalance,
        balance: '100.0000000',
      });
      mockPrisma.walletBalance.upsert.mockResolvedValue({});

      const result = await service.syncWalletBalances({ walletId: WALLET_ID });

      expect(result.mismatchesFound).toBe(1);
      expect(result.syncStatus).toBe(BalanceSyncStatus.MISMATCH);
    });

    it('marks balances as FAILED and updates job on error', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
      });
      mockHorizon.accountExists.mockRejectedValue(new Error('Horizon down'));
      mockPrisma.walletBalance.updateMany.mockResolvedValue({});

      await expect(
        service.syncWalletBalances({ walletId: WALLET_ID }),
      ).rejects.toThrow('Balance sync failed: Horizon down');

      expect(mockPrisma.walletBalance.updateMany).toHaveBeenCalledWith({
        where: { walletId: WALLET_ID },
        data: { syncStatus: BalanceSyncStatus.FAILED },
      });
      expect(mockPrisma.balanceSyncJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });
  });

  // ─── reconcileBalance ─────────────────────────────────────────────────────────

  describe('reconcileBalance', () => {
    it('returns matches=true when indexed equals on-chain', async () => {
      mockPrisma.walletBalance.findUnique.mockResolvedValue(nativeBalance);
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
      });
      mockHorizon.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      mockPrisma.walletBalance.updateMany.mockResolvedValue({});

      const result = await service.reconcileBalance(WALLET_ID, nativeAsset);

      expect(result.matches).toBe(true);
      expect(result.indexedBalance).toBe('100.0000000');
      expect(result.onChainBalance).toBe('100.0000000');
    });

    it('returns matches=false and corrects balance on mismatch', async () => {
      mockPrisma.walletBalance.findUnique.mockResolvedValue(nativeBalance); // indexed=100
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
      });
      mockHorizon.getAccountBalances.mockResolvedValue([
        makeBalanceUpdate('200.0000000'),
      ]); // on-chain=200
      mockPrisma.walletBalance.upsert.mockResolvedValue({});
      mockPrisma.walletBalance.updateMany.mockResolvedValue({});

      const result = await service.reconcileBalance(WALLET_ID, nativeAsset);

      expect(result.matches).toBe(false);
      expect(result.difference).toBeDefined();
      expect(mockPrisma.walletBalance.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mismatchDetectedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('throws NotFoundException when wallet not found', async () => {
      mockPrisma.walletBalance.findUnique.mockResolvedValue(null);
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.reconcileBalance(WALLET_ID, nativeAsset),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── syncAllWallets ───────────────────────────────────────────────────────────

  describe('syncAllWallets', () => {
    it('syncs all active wallets and aggregates results', async () => {
      mockPrisma.wallet.findMany.mockResolvedValue([
        { id: 'w1', publicKey: 'PK1', status: 'ACTIVE' },
        { id: 'w2', publicKey: 'PK2', status: 'ACTIVE' },
      ]);
      mockPrisma.wallet.findUnique.mockImplementation(({ where }: any) => {
        const wallet = [
          { id: 'w1', publicKey: 'PK1', status: 'ACTIVE' },
          { id: 'w2', publicKey: 'PK2', status: 'ACTIVE' },
        ].find((w) => w.id === where.id);
        return Promise.resolve(wallet ?? null);
      });
      mockHorizon.accountExists.mockResolvedValue(true);
      mockHorizon.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      mockPrisma.walletBalance.findUnique.mockResolvedValue(null);
      mockPrisma.walletBalance.upsert.mockResolvedValue({});

      const result = await service.syncAllWallets();

      expect(result.walletsProcessed).toBe(2);
      expect(result.balancesUpdated).toBe(2);
    });

    it('continues processing remaining wallets on individual failure', async () => {
      mockPrisma.wallet.findMany.mockResolvedValue([
        { id: 'w1', publicKey: 'PK1', status: 'ACTIVE' },
        { id: 'w2', publicKey: 'PK2', status: 'ACTIVE' },
      ]);

      // w1 fails, w2 succeeds
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce(null) // w1 → NotFoundException
        .mockResolvedValueOnce({ id: 'w2', publicKey: 'PK2' });

      mockHorizon.accountExists.mockResolvedValue(true);
      mockHorizon.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      mockPrisma.walletBalance.findUnique.mockResolvedValue(null);
      mockPrisma.walletBalance.upsert.mockResolvedValue({});
      mockPrisma.walletBalance.updateMany.mockResolvedValue({});

      const result = await service.syncAllWallets();

      expect(result.walletsProcessed).toBe(1);
    });
  });
});
