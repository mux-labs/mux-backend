/**
 * BalanceIndexerService integration harness (#382)
 *
 * Wires BalanceIndexerService with an in-memory Prisma stub to exercise
 * event indexing, idempotency, ordering, and retry behaviour.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import {
  AssetType,
  BalanceChangeEvent,
  BalanceSyncStatus,
} from './domain/balance.model';

const WALLET_ID = 'wallet-integration-1';
const NOW = new Date('2026-06-01T12:00:00.000Z');

const nativeEvent = (
  overrides: Partial<BalanceChangeEvent> = {},
): BalanceChangeEvent => ({
  walletId: WALLET_ID,
  asset: { type: AssetType.NATIVE },
  balance: '100.0000000',
  ledgerSequence: 1000,
  transactionHash: 'tx-hash-1',
  timestamp: NOW,
  ...overrides,
});

const creditEvent = (
  overrides: Partial<BalanceChangeEvent> = {},
): BalanceChangeEvent => ({
  walletId: WALLET_ID,
  asset: {
    type: AssetType.CREDIT_ALPHANUM4,
    code: 'USDC',
    issuer: 'GUSDC123',
  },
  balance: '25.0000000',
  ledgerSequence: 1001,
  transactionHash: 'tx-hash-usdc-1',
  timestamp: NOW,
  ...overrides,
});

describe('BalanceIndexerService (integration harness)', () => {
  let service: BalanceIndexerService;
  let balanceStore: Map<string, any>;
  let mockPrisma: any;
  let mockHorizon: {
    getAccountBalances: jest.Mock;
    accountExists: jest.Mock;
  };
  let syncWalletBalancesSpy: jest.SpyInstance;

  const compoundKey = (walletId: string, asset: BalanceChangeEvent['asset']) =>
    [
      walletId,
      asset.type,
      asset.code ?? null,
      asset.issuer ?? null,
    ].join('|');

  beforeEach(async () => {
    balanceStore = new Map();
    mockHorizon = {
      getAccountBalances: jest.fn(),
      accountExists: jest.fn(),
    };

    mockPrisma = {
      walletBalance: {
        findUnique: jest.fn(({ where }) => {
          const key = compoundKey(
            where.walletId_assetType_assetCode_assetIssuer.walletId,
            {
              type: where.walletId_assetType_assetCode_assetIssuer.assetType,
              code:
                where.walletId_assetType_assetCode_assetIssuer.assetCode ??
                undefined,
              issuer:
                where.walletId_assetType_assetCode_assetIssuer.assetIssuer ??
                undefined,
            },
          );
          return Promise.resolve(balanceStore.get(key) ?? null);
        }),
        findMany: jest.fn(({ where }) => {
          const rows = [...balanceStore.values()].filter(
            (row) => row.walletId === where.walletId,
          );
          return Promise.resolve(rows);
        }),
        upsert: jest.fn(({ where, create, update }) => {
          const key = compoundKey(
            where.walletId_assetType_assetCode_assetIssuer.walletId,
            {
              type: where.walletId_assetType_assetCode_assetIssuer.assetType,
              code:
                where.walletId_assetType_assetCode_assetIssuer.assetCode ??
                undefined,
              issuer:
                where.walletId_assetType_assetCode_assetIssuer.assetIssuer ??
                undefined,
            },
          );
          const existing = balanceStore.get(key);
          const row = existing
            ? { ...existing, ...update }
            : { id: `bal-${balanceStore.size + 1}`, ...create };
          balanceStore.set(key, row);
          return Promise.resolve(row);
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      wallet: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      balanceSyncJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceIndexerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarHorizonService, useValue: mockHorizon },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
          },
        },
        {
          provide: WebhookEventEmitterService,
          useValue: {
            emitBalanceUpdated: jest.fn(),
            emitBalanceMismatch: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BalanceIndexerService>(BalanceIndexerService);
    syncWalletBalancesSpy = jest
      .spyOn(service, 'syncWalletBalances')
      .mockResolvedValue({
        walletId: WALLET_ID,
        balancesUpdated: 1,
        mismatchesFound: 0,
        syncStatus: BalanceSyncStatus.SYNCED,
        lastSyncedAt: NOW,
      });
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('indexes a new balance event and creates a DB record', async () => {
    const event = nativeEvent();

    const result = await service.indexBalanceEvent(event);

    expect(result).toEqual({ action: 'indexed' });
    expect(mockPrisma.walletBalance.upsert).toHaveBeenCalledTimes(1);
    const stored = await mockPrisma.walletBalance.findMany({
      where: { walletId: WALLET_ID },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      walletId: WALLET_ID,
      balance: '100.0000000',
      lastSyncedLedger: 1000,
      assetType: AssetType.NATIVE,
    });
  });

  it('updates an existing balance for the same account and asset', async () => {
    await service.indexBalanceEvent(nativeEvent());
    await service.indexBalanceEvent(
      nativeEvent({
        balance: '150.0000000',
        ledgerSequence: 1005,
        transactionHash: 'tx-hash-2',
      }),
    );

    const stored = await mockPrisma.walletBalance.findMany({
      where: { walletId: WALLET_ID },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].balance).toBe('150.0000000');
    expect(stored[0].lastSyncedLedger).toBe(1005);
  });

  it('is idempotent for duplicate ledger sequence and transaction hash', async () => {
    const event = nativeEvent();

    await service.indexBalanceEvent(event);
    await service.indexBalanceEvent(event);

    expect(mockPrisma.walletBalance.upsert).toHaveBeenCalledTimes(1);
    const stored = await mockPrisma.walletBalance.findMany({
      where: { walletId: WALLET_ID },
    });
    expect(stored).toHaveLength(1);
  });

  it('does not overwrite a newer balance with an older out-of-order event', async () => {
    await service.indexBalanceEvent(
      nativeEvent({
        balance: '200.0000000',
        ledgerSequence: 2000,
        transactionHash: 'tx-newer',
      }),
    );

    const result = await service.indexBalanceEvent(
      nativeEvent({
        balance: '50.0000000',
        ledgerSequence: 1500,
        transactionHash: 'tx-older',
      }),
    );

    expect(result).toEqual({ action: 'skipped', reason: 'out_of_order' });
    const stored = await mockPrisma.walletBalance.findMany({
      where: { walletId: WALLET_ID },
    });
    expect(stored[0].balance).toBe('200.0000000');
    expect(stored[0].lastSyncedLedger).toBe(2000);
  });

  it('creates separate balance records for multiple assets on the same account', async () => {
    await service.indexBalanceEvent(nativeEvent());
    await service.indexBalanceEvent(creditEvent());

    const stored = await mockPrisma.walletBalance.findMany({
      where: { walletId: WALLET_ID },
    });
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.assetType).sort()).toEqual([
      AssetType.CREDIT_ALPHANUM4,
      AssetType.NATIVE,
    ]);
  });

  it('retries indexing when the database is temporarily unavailable', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    syncWalletBalancesSpy.mockRestore();

    mockPrisma.wallet.findUnique
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ id: WALLET_ID, publicKey: 'GABC123' });
    mockHorizon.accountExists.mockResolvedValue(true);
    mockHorizon.getAccountBalances.mockResolvedValue([]);

    const result = await service.syncWalletBalancesWithRetry({
      walletId: WALLET_ID,
    });

    expect(result.walletId).toBe(WALLET_ID);
    expect(mockPrisma.wallet.findUnique).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Sync retry 1/3'),
    );
  });
});
