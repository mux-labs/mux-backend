import { Test } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { BalanceIndexerService } from '../src/balance-indexer/balance-indexer.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('BalanceIndexerController (e2e)', () => {
  let app: INestApplication;
  
  const mockBalanceIndexerService = {
    getAllBalances: jest.fn().mockResolvedValue([
      { assetType: 'NATIVE', balance: '100.0000000', syncStatus: 'SYNCED' }
    ]),
    getBalance: jest.fn().mockResolvedValue({
      assetType: 'NATIVE',
      balance: '100.0000000',
      syncStatus: 'SYNCED'
    }),
    syncWalletBalances: jest.fn().mockResolvedValue({
      walletId: 'wallet-123',
      balancesUpdated: 1,
      mismatchesFound: 0,
      syncStatus: 'SYNCED',
      lastSyncedAt: new Date()
    }),
    syncAllWallets: jest.fn().mockResolvedValue({
      walletsProcessed: 1,
      balancesUpdated: 1,
      mismatchesFound: 0
    }),
    reconcileBalance: jest.fn().mockResolvedValue({
      walletId: 'wallet-123',
      asset: { type: 'NATIVE' },
      indexedBalance: '100.0000000',
      onChainBalance: '100.0000000',
      matches: true
    }),
    reconcileAllBalances: jest.fn().mockResolvedValue({
      walletsProcessed: 1,
      mismatchesFound: 0
    }),
    syncWalletBalancesWithRetry: jest.fn().mockResolvedValue({
      walletId: 'wallet-123',
      balancesUpdated: 1,
      mismatchesFound: 0,
      syncStatus: 'SYNCED',
      lastSyncedAt: new Date()
    }),
    detectStaleBalances: jest.fn().mockResolvedValue({
      walletId: 'wallet-123',
      staleAssets: [],
      staleSince: null
    }),
    runScheduledSync: jest.fn().mockResolvedValue(undefined)
  };

  const mockApiKeyService = {
    validateApiKey: jest.fn(async (key: string) => ({
      apiKey: { id: 'api-key-id' },
      project: { id: 'proj-id', name: 'proj-name' },
      developer: { id: 'dev-id', email: 'dev@example.com' }
    })),
    recordUsage: jest.fn(async () => {})
  };

  const mockPrismaService = {
    $connect: jest.fn(),
    $disconnect: jest.fn()
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BalanceIndexerService)
      .useValue(mockBalanceIndexerService)
      .overrideProvider(ApiKeyService)
      .useValue(mockApiKeyService)
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /v1/balances/wallet/:walletId should return wallet balances', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/balances/wallet/wallet-123')
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('walletId', 'wallet-123');
    expect(res.body).toHaveProperty('balances');
    expect(res.body.balances[0].balance).toBe('100.0000000');
    expect(mockBalanceIndexerService.getAllBalances).toHaveBeenCalledWith('wallet-123');
  });

  it('GET /v1/balances/wallet/:walletId/asset should return asset balance', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/balances/wallet/wallet-123/asset')
      .query({ assetType: 'NATIVE' })
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('walletId', 'wallet-123');
    expect(res.body).toHaveProperty('balances');
    expect(mockBalanceIndexerService.getAllBalances).toHaveBeenCalledWith('wallet-123');
  });

  it('POST /v1/balances/wallet/:walletId/sync should trigger manual sync', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/balances/wallet/wallet-123/sync')
      .send({ forceRefresh: true })
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('walletId', 'wallet-123');
    expect(res.body).toHaveProperty('balancesUpdated', 1);
    expect(mockBalanceIndexerService.syncWalletBalances).toHaveBeenCalledWith({
      walletId: 'wallet-123',
      forceRefresh: true
    });
  });

  it('POST /v1/balances/sync-all should sync all wallets', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/balances/sync-all')
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('walletsProcessed', 1);
    expect(mockBalanceIndexerService.syncAllWallets).toHaveBeenCalled();
  });

  it('POST /v1/balances/wallet/:walletId/reconcile should reconcile specific asset', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/balances/wallet/wallet-123/reconcile')
      .send({ assetType: 'NATIVE' })
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('walletId', 'wallet-123');
    expect(res.body).toHaveProperty('matches', true);
    expect(mockBalanceIndexerService.reconcileBalance).toHaveBeenCalledWith('wallet-123', {
      type: 'NATIVE',
      code: undefined,
      issuer: undefined
    });
  });

  it('POST /v1/balances/reconcile-all should reconcile all wallets', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/balances/reconcile-all')
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('walletsProcessed', 1);
    expect(res.body).toHaveProperty('mismatchesFound', 0);
    expect(mockBalanceIndexerService.reconcileAllBalances).toHaveBeenCalled();
  });

  it('POST /v1/balances/wallet/:walletId/sync-with-retry should sync with retry', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/balances/wallet/wallet-123/sync-with-retry')
      .send({ forceRefresh: true })
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('walletId', 'wallet-123');
    expect(mockBalanceIndexerService.syncWalletBalancesWithRetry).toHaveBeenCalledWith({
      walletId: 'wallet-123',
      forceRefresh: true
    });
  });

  it('GET /v1/balances/wallet/:walletId/stale should detect stale balances', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/balances/wallet/wallet-123/stale')
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('staleAssets');
    expect(mockBalanceIndexerService.detectStaleBalances).toHaveBeenCalledWith('wallet-123');
  });

  it('POST /v1/balances/scheduled-sync should manually trigger scheduled sync', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/balances/scheduled-sync')
      .set('Authorization', 'ApiKey mux_test_key')
      .expect(HttpStatus.OK);

    expect(res.body).toHaveProperty('status', 'scheduled sync triggered');
    expect(mockBalanceIndexerService.runScheduledSync).toHaveBeenCalled();
  });
});
