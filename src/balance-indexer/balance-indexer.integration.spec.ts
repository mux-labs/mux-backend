/**
 * Balance Indexer Integration Test Harness (#382)
 *
 * Wires the real BalanceIndexerService with controlled Prisma/Horizon stubs
 * to exercise balance event indexing without a live database.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { AssetType, BalanceSyncStatus } from './domain/balance.model';

const WALLET_ID = 'wallet-integration-1';
const TX_HASH_A = 'abc123txhash';
const TX_HASH_B = 'def456txhash';

const nativeAsset = { type: AssetType.NATIVE };

const makeBalanceRecord = (
  balance: string,
  ledgerSequence: number,
  assetType = AssetType.NATIVE,
  assetCode: string | null = null,
  assetIssuer: string | null = null,
) => ({
  id: `bal-${assetType}-${assetCode ?? 'native'}`,
  walletId: WALLET_ID,
  assetType,
  assetCode,
  assetIssuer,
  balance,
  syncStatus: BalanceSyncStatus.SYNCED,
  lastSyncedAt: new Date(),
  lastSyncedLedger: ledgerSequence,
  lastReconciledAt: null,
  reconciliationAttempts: 0,
  onChainBalance: balance,
  mismatchDetectedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('BalanceIndexerService (integration harness)', () => {
  let service: BalanceIndexerService;
  let prisma: jest.Mocked<PrismaService>;

  const balanceStore = new Map<string, ReturnType<typeof makeBalanceRecord>>();

  const storeKey = (
    walletId: string,
    assetType: string,
    assetCode: string | null,
    assetIssuer: string | null,
  ) => `${walletId}:${assetType}:${assetCode ?? ''}:${assetIssuer ?? ''}`;

  const mockPrisma = {
    walletBalance: {
      findUnique: jest.fn(({ where }: any) => {
        const key = storeKey(
          where.walletId_assetType_assetCode_assetIssuer.walletId,
          where.walletId_assetType_assetCode_assetIssuer.assetType,
          where.walletId_assetType_assetCode_assetIssuer.assetCode,
          where.walletId_assetType_assetCode_assetIssuer.assetIssuer,
        );
        return Promise.resolve(balanceStore.get(key) ?? null);
      }),
      findMany: jest.fn(({ where }: any) => {
        const rows = [...balanceStore.values()].filter(
          (row) => row.walletId === where.walletId,
        );
        return Promise.resolve(rows);
      }),
      upsert: jest.fn(({ where, create, update }: any) => {
        const compound = where.walletId_assetType_assetCode_assetIssuer;
        const key = storeKey(
          compound.walletId,
          compound.assetType,
          compound.assetCode,
          compound.assetIssuer,
        );
        const existing = balanceStore.get(key);
        const record = existing
          ? { ...existing, ...update, balance: update.balance ?? existing.balance }
          : { ...makeBalanceRecord(create.balance, create.lastSyncedLedger ?? 0), ...create };
        balanceStore.set(key, record);
        return Promise.resolve(record);
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
  };

  const mockWebhookEmitter = {
    emitBalanceUpdated: jest.fn().mockResolvedValue(undefined),
    emitBalanceMismatch: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    balanceStore.clear();
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
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('indexBalanceEvent', () => {
    it('creates a balance record for a new balance event', async () => {
      await service.indexBalanceEvent({
        walletId: WALLET_ID,
        asset: nativeAsset,
        balance: '250.0000000',
        ledgerSequence: 1000,
        transactionHash: TX_HASH_A,
      });

      expect(prisma.walletBalance.upsert).toHaveBeenCalledTimes(1);
      const record = [...balanceStore.values()][0];
      expect(record).toMatchObject({
        walletId: WALLET_ID,
        assetType: AssetType.NATIVE,
        balance: '250.0000000',
        lastSyncedLedger: 1000,
      });
    });

    it('updates an existing balance to the latest value without duplicating records', async () => {
      await service.indexBalanceEvent({
        walletId: WALLET_ID,
        asset: nativeAsset,
        balance: '100.0000000',
        ledgerSequence: 1000,
        transactionHash: TX_HASH_A,
      });

      await service.indexBalanceEvent({
        walletId: WALLET_ID,
        asset: nativeAsset,
        balance: '150.0000000',
        ledgerSequence: 1001,
        transactionHash: TX_HASH_B,
      });

      expect(balanceStore.size).toBe(1);
      const record = [...balanceStore.values()][0];
      expect(record.balance).toBe('150.0000000');
      expect(record.lastSyncedLedger).toBe(1001);
    });

    it('is idempotent when the same event is emitted twice', async () => {
      const event = {
        walletId: WALLET_ID,
        asset: nativeAsset,
        balance: '100.0000000',
        ledgerSequence: 1000,
        transactionHash: TX_HASH_A,
      };

      await service.indexBalanceEvent(event);
      await service.indexBalanceEvent(event);

      expect(prisma.walletBalance.upsert).toHaveBeenCalledTimes(1);
      expect(balanceStore.size).toBe(1);
    });

    it('does not overwrite a newer balance with an older out-of-order event', async () => {
      await service.indexBalanceEvent({
        walletId: WALLET_ID,
        asset: nativeAsset,
        balance: '200.0000000',
        ledgerSequence: 2000,
        transactionHash: TX_HASH_B,
      });

      await service.indexBalanceEvent({
        walletId: WALLET_ID,
        asset: nativeAsset,
        balance: '50.0000000',
        ledgerSequence: 1000,
        transactionHash: TX_HASH_A,
      });

      const record = [...balanceStore.values()][0];
      expect(record.balance).toBe('200.0000000');
      expect(record.lastSyncedLedger).toBe(2000);
      expect(prisma.walletBalance.upsert).toHaveBeenCalledTimes(1);
    });

    it('creates separate balance records for multiple assets on the same account', async () => {
      const usdcAsset = {
        type: AssetType.CREDIT_ALPHANUM4,
        code: 'USDC',
        issuer: 'GISSUER123',
      };

      await service.indexBalanceEvent({
        walletId: WALLET_ID,
        asset: nativeAsset,
        balance: '10.0000000',
        ledgerSequence: 1000,
        transactionHash: TX_HASH_A,
      });

      await service.indexBalanceEvent({
        walletId: WALLET_ID,
        asset: usdcAsset,
        balance: '500.0000000',
        ledgerSequence: 1001,
        transactionHash: TX_HASH_B,
      });

      expect(balanceStore.size).toBe(2);
      const balances = [...balanceStore.values()];
      expect(balances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assetType: AssetType.NATIVE,
            balance: '10.0000000',
          }),
          expect.objectContaining({
            assetType: AssetType.CREDIT_ALPHANUM4,
            assetCode: 'USDC',
            balance: '500.0000000',
          }),
        ]),
      );
    });
  });

  describe('syncWalletBalancesWithRetry', () => {
    it('logs the error, does not crash, and retries when the database is unavailable', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      mockPrisma.wallet.findUnique
        .mockRejectedValueOnce(new Error('Database connection failed'))
        .mockResolvedValueOnce({
          id: WALLET_ID,
          publicKey: 'GABC123',
        });

      mockHorizon.accountExists.mockResolvedValue(true);
      mockHorizon.getAccountBalances.mockResolvedValue([
        {
          walletId: WALLET_ID,
          asset: nativeAsset,
          balance: '100.0000000',
          ledgerSequence: 1000,
          timestamp: new Date(),
        },
      ]);

      const result = await service.syncWalletBalancesWithRetry({
        walletId: WALLET_ID,
      });

      expect(result.balancesUpdated).toBe(1);
      expect(mockPrisma.wallet.findUnique).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sync retry 1/3'),
      );
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });
});
