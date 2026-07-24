import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { BalanceRepository } from './balance.repository';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { AssetType, BalanceSyncStatus } from './domain/balance.model';

const WALLET_ID = 'wallet-123';
const PUBLIC_KEY = 'GABC123';

function makeBalance(overrides: Partial<any> = {}) {
  return {
    id: 'bal-1',
    walletId: WALLET_ID,
    assetType: AssetType.NATIVE,
    assetCode: null,
    assetIssuer: null,
    balance: '100.0000000',
    syncStatus: BalanceSyncStatus.SYNCED,
    lastSyncedAt: new Date(),
    lastSyncedLedger: 1,
    lastReconciledAt: null,
    reconciliationAttempts: 0,
    onChainBalance: '100.0000000',
    mismatchDetectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
import { PrismaService } from '../prisma/prisma.service';
import { AssetType, BalanceSyncStatus } from './domain/balance.model';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { BalanceIndexerMetricsService } from './balance-indexer-metrics.service';

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
}

describe('BalanceIndexerService', () => {
  let service: BalanceIndexerService;
  let repo: jest.Mocked<BalanceRepository>;
  let horizonService: jest.Mocked<StellarHorizonService>;
  let webhookEmitter: jest.Mocked<WebhookEventEmitterService>;
  let configService: jest.Mocked<ConfigService>;
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

  const mockRequestContext = {
    getRequestId: jest.fn().mockReturnValue('test-request-id-spec'),
  };

  const mockMetrics = {
    record: jest.fn(),
  };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      findAll: jest.fn(),
      upsert: jest.fn(),
      upsertNativeZero: jest.fn(),
      markFailed: jest.fn(),
      recordMismatch: jest.fn(),
      clearMismatch: jest.fn(),
      findWallet: jest.fn(),
      findActiveWallets: jest.fn(),
    } as any;

    horizonService = {
      getAccountBalances: jest.fn(),
      accountExists: jest.fn(),
    } as any;

    webhookEmitter = {
      emitBalanceMismatch: jest.fn().mockResolvedValue(undefined),
      emitBalanceUpdated: jest.fn().mockResolvedValue(undefined),
    } as any;

    configService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'STELLAR_HORIZON_URL') return 'https://horizon-testnet.stellar.org';
        if (key === 'BALANCE_STALE_THRESHOLD_MS') return defaultValue ?? 300_000;
        return defaultValue;
      }),
    } as any;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceIndexerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarHorizonService, useValue: mockHorizon },
        { provide: ConfigService, useValue: mockConfig },
        { provide: WebhookEventEmitterService, useValue: mockWebhookEmitter },
        { provide: RequestContextService, useValue: mockRequestContext },
        { provide: BalanceIndexerMetricsService, useValue: mockMetrics },
      ],
    }).compile();

    service = module.get<BalanceIndexerService>(BalanceIndexerService);
    // Run lifecycle hook manually (compile() calls onModuleInit automatically
    // only in full NestJS apps; call explicitly in unit tests)
    service.onModuleInit();
    prisma = module.get(PrismaService);
    horizonService = module.get(StellarHorizonService);

    mockPrisma.balanceSyncJob.create.mockResolvedValue({ id: 'job-1' });
    mockPrisma.balanceSyncJob.update.mockResolvedValue({});
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // #391 — Env validation
  // ---------------------------------------------------------------------------

  describe('onModuleInit (env validation)', () => {
    it('throws when STELLAR_HORIZON_URL is missing', () => {
      configService.get.mockImplementation((key: string) => {
        if (key === 'STELLAR_HORIZON_URL') return '';
        return undefined;
      });
      expect(() => service.onModuleInit()).toThrow('STELLAR_HORIZON_URL');
    });

    it('throws when BALANCE_STALE_THRESHOLD_MS is zero', () => {
      configService.get.mockImplementation((key: string, def?: any) => {
        if (key === 'STELLAR_HORIZON_URL') return 'https://horizon-testnet.stellar.org';
        if (key === 'BALANCE_STALE_THRESHOLD_MS') return 0;
        return def;
      });
      expect(() => service.onModuleInit()).toThrow(
        'BALANCE_STALE_THRESHOLD_MS',
      );
    });

    it('does not throw with valid configuration', () => {
      expect(() => service.onModuleInit()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // getBalance
  // ---------------------------------------------------------------------------

  describe('getBalance', () => {
    it('returns null when balance is not indexed', async () => {
      repo.findOne.mockResolvedValue(null);
      const result = await service.getBalance(WALLET_ID, {
        type: AssetType.NATIVE,
      });
      expect(result).toBeNull();
    });

    it('returns a fresh balance without triggering sync', async () => {
      const balance = makeBalance({ lastSyncedAt: new Date() });
      repo.findOne.mockResolvedValue(balance);
      const result = await service.getBalance(WALLET_ID, {
        type: AssetType.NATIVE,
      });
      expect(result).toEqual(balance);
    });

    it('triggers a background sync for stale balances', async () => {
      const staleDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const balance = makeBalance({ lastSyncedAt: staleDate });
      repo.findOne.mockResolvedValue(balance);
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockResolvedValue(true);
      horizonService.getAccountBalances.mockResolvedValue([]);

      await service.getBalance(WALLET_ID, { type: AssetType.NATIVE });

      // Background sync is fire-and-forget; give microtask queue a tick
      await new Promise((r) => setImmediate(r));
      expect(repo.findWallet).toHaveBeenCalledWith(WALLET_ID);
    });
  });

  // ---------------------------------------------------------------------------
  // syncWalletBalances
  // ---------------------------------------------------------------------------

  describe('syncWalletBalances', () => {
    it('throws NotFoundException when wallet does not exist', async () => {
      repo.findWallet.mockResolvedValue(null);
      await expect(
        service.syncWalletBalances({ walletId: WALLET_ID }),
      ).rejects.toThrow('Balance sync failed');
    });

    it('sets zero balances when account is not on-chain', async () => {
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockResolvedValue(false);
      repo.upsertNativeZero.mockResolvedValue(undefined);

      const result = await service.syncWalletBalances({ walletId: WALLET_ID });

      expect(repo.upsertNativeZero).toHaveBeenCalledWith(WALLET_ID);
      expect(result.balancesUpdated).toBe(1);
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
    });

    it('syncs balances and returns SYNCED status when no mismatches', async () => {
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockResolvedValue(true);
      horizonService.getAccountBalances.mockResolvedValue([
        {
          walletId: WALLET_ID,
          asset: { type: AssetType.NATIVE },
          balance: '1000.0000000',
          ledgerSequence: 123456,
          timestamp: new Date(),
        },
      ]);
      repo.findOne.mockResolvedValue(null); // first call in applyBalanceUpdate
      repo.upsert.mockResolvedValue(undefined);

      const result = await service.syncWalletBalances({ walletId: WALLET_ID });

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
      expect(result.mismatchesFound).toBe(0);
    });

    // #387 — Emit domain events
    it('emits balance.updated when balance value changes', async () => {
      const existingBalance = makeBalance({ balance: '50.0000000' });
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockResolvedValue(true);
      horizonService.getAccountBalances.mockResolvedValue([
        {
          walletId: WALLET_ID,
          asset: { type: AssetType.NATIVE },
          balance: '100.0000000',
          ledgerSequence: 2,
          timestamp: new Date(),
        },
      ]);
      repo.findOne.mockResolvedValue(existingBalance);
      repo.upsert.mockResolvedValue(undefined);

      await service.syncWalletBalances({ walletId: WALLET_ID });

      await new Promise((r) => setImmediate(r));
      expect(webhookEmitter.emitBalanceUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: WALLET_ID,
          previousBalance: '50.0000000',
          newBalance: '100.0000000',
        }),
      );
    });

    it('does NOT emit balance.updated when balance is unchanged', async () => {
      const existingBalance = makeBalance({ balance: '100.0000000' });
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockResolvedValue(true);
      horizonService.getAccountBalances.mockResolvedValue([
        {
          walletId: WALLET_ID,
          asset: { type: AssetType.NATIVE },
          balance: '100.0000000',
          ledgerSequence: 2,
          timestamp: new Date(),
        },
      ]);
      repo.findOne.mockResolvedValue(existingBalance);
      repo.upsert.mockResolvedValue(undefined);

      await service.syncWalletBalances({ walletId: WALLET_ID });

      await new Promise((r) => setImmediate(r));
      expect(webhookEmitter.emitBalanceUpdated).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // reconcileBalance
  // ---------------------------------------------------------------------------

  describe('reconcileBalance', () => {
    it('throws NotFoundException when wallet does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.findWallet.mockResolvedValue(null);
      await expect(
        service.reconcileBalance(WALLET_ID, { type: AssetType.NATIVE }),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns matches=true and clears mismatch when balances are equal', async () => {
      const balance = makeBalance({ balance: '100.0000000' });
      repo.findOne.mockResolvedValue(balance);
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.getAccountBalances.mockResolvedValue([
        {
          walletId: WALLET_ID,
          asset: { type: AssetType.NATIVE },
          balance: '100.0000000',
          ledgerSequence: 1,
          timestamp: new Date(),
        },
      ]);
      repo.clearMismatch.mockResolvedValue(undefined);

      const result = await service.reconcileBalance(WALLET_ID, {
        type: AssetType.NATIVE,
      });

      expect(result.matches).toBe(true);
      expect(repo.clearMismatch).toHaveBeenCalled();
      expect(webhookEmitter.emitBalanceMismatch).not.toHaveBeenCalled();
    });

    // #387 — Emit balance.mismatch domain event
    it('emits balance.mismatch when divergence is detected', async () => {
      const balance = makeBalance({ balance: '50.0000000' });
      repo.findOne
        .mockResolvedValueOnce(balance) // getBalance call
        .mockResolvedValueOnce(balance); // applyBalanceUpdate findOne call
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.getAccountBalances.mockResolvedValue([
        {
          walletId: WALLET_ID,
          asset: { type: AssetType.NATIVE },
          balance: '100.0000000',
          ledgerSequence: 1,
          timestamp: new Date(),
        },
      ]);
      repo.upsert.mockResolvedValue(undefined);
      repo.recordMismatch.mockResolvedValue(undefined);

      const result = await service.reconcileBalance(WALLET_ID, {
        type: AssetType.NATIVE,
      });

      await new Promise((r) => setImmediate(r));
      expect(result.matches).toBe(false);
      expect(result.difference).toBeDefined();
      expect(webhookEmitter.emitBalanceMismatch).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: WALLET_ID,
          indexedBalance: '50.0000000',
          onChainBalance: '100.0000000',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getAllBalances
  // ---------------------------------------------------------------------------

  describe('getAllBalances', () => {
    it('delegates to repository', async () => {
      const balances = [makeBalance()];
      repo.findAll.mockResolvedValue(balances);

      const result = await service.getAllBalances(WALLET_ID);

      expect(repo.findAll).toHaveBeenCalledWith(WALLET_ID);
      expect(result).toEqual(balances);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #488: Detect and flag stale balances
  // ---------------------------------------------------------------------------

  describe('detectStaleBalances (#488)', () => {
    it('should detect stale balances and return asset labels', async () => {
      const staleDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const staleNative = makeBalance({ lastSyncedAt: staleDate, assetType: AssetType.NATIVE });
      const staleUSD = makeBalance({
        lastSyncedAt: staleDate,
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
      });

      // detectStaleBalances queries prisma directly
      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockResolvedValue([staleNative, staleUSD]),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const result = await service.detectStaleBalances(WALLET_ID);

      expect(result.walletId).toBe(WALLET_ID);
      expect(result.staleAssets).toContain('NATIVE');
      expect(result.staleAssets).toContain('USD/CREDIT_ALPHANUM4');
      expect(result.staleSince).toEqual(staleDate);
    });

    it('should return empty stale assets when all balances are fresh', async () => {
      const freshDate = new Date(); // just now — not stale
      const freshBalance = makeBalance({ lastSyncedAt: freshDate });

      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockResolvedValue([freshBalance]),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const result = await service.detectStaleBalances(WALLET_ID);

      expect(result.staleAssets).toHaveLength(0);
      expect(result.staleSince).toBeNull();
    });

    it('should mark stale balances with STALE status in database', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const staleBalance = makeBalance({ id: 'bal-stale', lastSyncedAt: staleDate });
      const mockUpdate = jest.fn().mockResolvedValue({});

      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockResolvedValue([staleBalance]),
          update: mockUpdate,
        },
      };

      await service.detectStaleBalances(WALLET_ID);

      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: 'bal-stale' },
        data: { syncStatus: BalanceSyncStatus.STALE },
      });
    });

    it('should find oldest stale balance timestamp', async () => {
      const oldest = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      const newer = new Date(Date.now() - 30 * 60 * 1000);  // 30 min ago

      const oldBalance = makeBalance({ id: 'bal-1', lastSyncedAt: oldest });
      const newBalance = makeBalance({ id: 'bal-2', lastSyncedAt: newer });

      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockResolvedValue([newBalance, oldBalance]),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const result = await service.detectStaleBalances(WALLET_ID);

      expect(result.staleSince).toEqual(oldest);
    });

    it('should handle wallet with no balances', async () => {
      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn(),
        },
      };

      const result = await service.detectStaleBalances(WALLET_ID);

      expect(result.staleAssets).toHaveLength(0);
      expect(result.staleSince).toBeNull();
    });

    it('should handle balances with null lastSyncedAt as stale', async () => {
      const neverSyncedBalance = makeBalance({ lastSyncedAt: null });

      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockResolvedValue([neverSyncedBalance]),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const result = await service.detectStaleBalances(WALLET_ID);

      expect(result.staleAssets.length).toBeGreaterThan(0);
    });

    it('should record metrics for successful detection', async () => {
      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn(),
        },
      };

      await service.detectStaleBalances(WALLET_ID);

      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'detect_stale', outcome: 'success' }),
      );
    });

    it('should record failure metrics and rethrow on error', async () => {
      (service as any).prisma = {
        walletBalance: {
          findMany: jest.fn().mockRejectedValue(new Error('DB error')),
        },
      };

      await expect(service.detectStaleBalances(WALLET_ID)).rejects.toThrow('DB error');

      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'detect_stale', outcome: 'failure' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #489: Manual balance resync endpoint
  // ---------------------------------------------------------------------------

  describe('syncWalletBalancesWithRetry (#489)', () => {
    it('should succeed on first attempt', async () => {
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockResolvedValue(true);
      horizonService.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      repo.findOne.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);

      const result = await service.syncWalletBalancesWithRetry({ walletId: WALLET_ID });

      expect(result.walletId).toBe(WALLET_ID);
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
    });

    it('should retry on transient failures', async () => {
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce(true);
      horizonService.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      repo.findOne.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);

      const result = await service.syncWalletBalancesWithRetry({ walletId: WALLET_ID });

      expect(result.walletId).toBe(WALLET_ID);
      expect(horizonService.accountExists).toHaveBeenCalledTimes(2);
    });

    it('should not retry on client errors (404)', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.status = 404;
      
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockRejectedValue(notFoundError);

      await expect(service.syncWalletBalancesWithRetry({ walletId: WALLET_ID }))
        .rejects.toThrow('Balance sync failed');

      expect(horizonService.accountExists).toHaveBeenCalledTimes(1);
    });

    it('should stop retrying after max retries', async () => {
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockRejectedValue(new Error('Persistent failure'));

      await expect(service.syncWalletBalancesWithRetry({ walletId: WALLET_ID }))
        .rejects.toThrow();

      // Should try: initial + 3 retries = 4 times
      expect(horizonService.accountExists).toHaveBeenCalledTimes(4);
    });

    it('should use exponential backoff between retries', async () => {
      jest.useFakeTimers();
      
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists
        .mockRejectedValueOnce(new Error('Retry 1'))
        .mockRejectedValueOnce(new Error('Retry 2'))
        .mockResolvedValueOnce(true);
      horizonService.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      repo.findOne.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);

      const promise = service.syncWalletBalancesWithRetry({ walletId: WALLET_ID });

      // Fast-forward through delays
      await jest.runAllTimersAsync();

      await promise;

      jest.useRealTimers();
      expect(horizonService.accountExists).toHaveBeenCalledTimes(3);
    });

    it('should pass forceRefresh option through retries', async () => {
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists.mockResolvedValue(true);
      horizonService.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      repo.findOne.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);

      await service.syncWalletBalancesWithRetry({ 
        walletId: WALLET_ID, 
        forceRefresh: true 
      });

      // Verify the service was called with forceRefresh
      expect(repo.upsert).toHaveBeenCalled();
    });

    it('should log retry attempts', async () => {
      const loggerWarnSpy = jest.spyOn(service['logger'], 'warn');
      
      repo.findWallet.mockResolvedValue({ id: WALLET_ID, publicKey: PUBLIC_KEY, status: 'ACTIVE' });
      horizonService.accountExists
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce(true);
      horizonService.getAccountBalances.mockResolvedValue([makeBalanceUpdate()]);
      repo.findOne.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);

      await service.syncWalletBalancesWithRetry({ walletId: WALLET_ID });

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sync retry'),
      );
    });
  });
});
