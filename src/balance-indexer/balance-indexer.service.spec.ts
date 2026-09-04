import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { BalanceRepository } from './balance.repository';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { BalanceIndexerMetricsService } from './balance-indexer-metrics.service';
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
  };
}

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

describe('BalanceIndexerService', () => {
  let service: BalanceIndexerService;
  let prisma: jest.Mocked<PrismaService>;
  let repo: jest.Mocked<BalanceRepository>;
  let horizonService: jest.Mocked<StellarHorizonService>;
  let webhookEmitter: jest.Mocked<WebhookEventEmitterService>;
  let configService: jest.Mocked<ConfigService>;
  const mockHorizon = {
    getAccountBalances: jest.fn(),
    accountExists: jest.fn(),
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
        if (key === 'STELLAR_HORIZON_URL')
          return 'https://horizon-testnet.stellar.org';
        if (key === 'BALANCE_STALE_THRESHOLD_MS')
          return defaultValue ?? 300_000;
        return defaultValue;
      }),
    } as any;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceIndexerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarHorizonService, useValue: mockHorizon },
        { provide: ConfigService, useValue: configService },
        { provide: WebhookEventEmitterService, useValue: webhookEmitter },
        { provide: RequestContextService, useValue: mockRequestContext },
        { provide: BalanceIndexerMetricsService, useValue: mockMetrics },
        { provide: BalanceRepository, useValue: repo },
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
        if (key === 'STELLAR_HORIZON_URL')
          return 'https://horizon-testnet.stellar.org';
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
      repo.findWallet.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
        status: 'ACTIVE',
      });
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
      repo.findWallet.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
        status: 'ACTIVE',
      });
      horizonService.accountExists.mockResolvedValue(false);
      repo.upsertNativeZero.mockResolvedValue(undefined);

      const result = await service.syncWalletBalances({ walletId: WALLET_ID });

      expect(repo.upsertNativeZero).toHaveBeenCalledWith(WALLET_ID);
      expect(result.balancesUpdated).toBe(1);
      expect(result.syncStatus).toBe(BalanceSyncStatus.SYNCED);
    });

    it('syncs balances and returns SYNCED status when no mismatches', async () => {
      repo.findWallet.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
        status: 'ACTIVE',
      });
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
      repo.findWallet.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
        status: 'ACTIVE',
      });
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
      repo.findWallet.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
        status: 'ACTIVE',
      });
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
      repo.findWallet.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
        status: 'ACTIVE',
      });
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
      repo.findWallet.mockResolvedValue({
        id: WALLET_ID,
        publicKey: PUBLIC_KEY,
        status: 'ACTIVE',
      });
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
});
