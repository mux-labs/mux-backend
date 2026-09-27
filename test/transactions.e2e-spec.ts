import { Test } from '@nestjs/testing';
import {
  INestApplication,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionQueryService } from '../src/transactions/transaction-query.service';
import { StellarTransactionBuildService } from '../src/transactions/stellar-transaction-build.service';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { RateLimitGuard } from '../src/rate-limit/rate-limit.guard';
import { FeatureFlagGuard } from '../src/common/feature-flags/feature-flag.guard';
import { TransactionStatus } from '../src/transactions/domain/transaction.model';

const TX_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const WALLET_ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const STELLAR_HASH = 'abc123stellar456hash789';

const makeTx = (overrides: Partial<any> = {}) => ({
  id: TX_ID,
  amount: '100',
  assetType: 'NATIVE',
  assetCode: null,
  assetIssuer: null,
  senderWalletId: WALLET_ID,
  receiverWalletId: null,
  status: TransactionStatus.PENDING,
  stellarHash: null,
  stellarLedger: null,
  stellarFee: null,
  statusChangedAt: new Date().toISOString(),
  statusReason: null,
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
  metadata: null,
  idempotencyKey: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const allowGuard = { canActivate: () => true };
const denyGuard = {
  canActivate: () => {
    throw new ForbiddenException('Forbidden');
  },
};

async function buildApp(guardPasses: boolean): Promise<INestApplication> {
  const guard = guardPasses ? allowGuard : denyGuard;

  const mockTransactionsService: Partial<TransactionsService> = {
    create: jest.fn(async () => makeTx()),
    updateStatus: jest.fn(async () =>
      makeTx({ status: TransactionStatus.SUBMITTED }),
    ),
  };

  const mockQueryService: Partial<TransactionQueryService> = {
    findAll: jest.fn(async () => [makeTx()]),
    findOne: jest.fn(async () => makeTx()),
    findByWallet: jest.fn(async () => [makeTx()]),
    findByStellarHash: jest.fn(async () =>
      makeTx({ stellarHash: STELLAR_HASH }),
    ),
  };

  const mockStellarBuildService: Partial<StellarTransactionBuildService> = {
    buildPayment: jest.fn(async () => ({
      xdr: 'AAAA==',
      sequence: '1234',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), TransactionsModule],
  })
    .overrideProvider(TransactionsService)
    .useValue(mockTransactionsService)
    .overrideProvider(TransactionQueryService)
    .useValue(mockQueryService)
    .overrideProvider(StellarTransactionBuildService)
    .useValue(mockStellarBuildService)
    .overrideGuard(ApiKeyGuard)
    .useValue(guard)
    .overrideGuard(RateLimitGuard)
    .useValue(allowGuard)
    .overrideGuard(FeatureFlagGuard)
    .useValue(allowGuard)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('Transactions API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp(true);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Authentication ─────────────────────────────────────────────────────────

  describe('Authentication guard', () => {
    it('returns 403 when the API key guard rejects the request', async () => {
      const unauthApp = await buildApp(false);
      try {
        const res = await request(unauthApp.getHttpServer())
          .get('/transactions')
          .expect(HttpStatus.FORBIDDEN);

        expect(res.body).toHaveProperty('statusCode', HttpStatus.FORBIDDEN);
      } finally {
        await unauthApp.close();
      }
    });
  });

  // ── GET /transactions ──────────────────────────────────────────────────────

  describe('GET /transactions', () => {
    it('returns 200 and an array of transactions', async () => {
      const res = await request(app.getHttpServer())
        .get('/transactions')
        .expect(HttpStatus.OK);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty('id', TX_ID);
    });

    it('forwards senderWalletId filter to the query service', async () => {
      await request(app.getHttpServer())
        .get('/transactions?senderWalletId=' + WALLET_ID)
        .expect(HttpStatus.OK);

      const queryMock = app.get<jest.Mocked<TransactionQueryService>>(
        TransactionQueryService,
      );
      expect(queryMock.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ senderWalletId: WALLET_ID }),
      );
    });

    it('forwards numeric limit and offset to the query service', async () => {
      await request(app.getHttpServer())
        .get('/transactions?limit=5&offset=10')
        .expect(HttpStatus.OK);

      const queryMock = app.get<jest.Mocked<TransactionQueryService>>(
        TransactionQueryService,
      );
      expect(queryMock.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5, offset: 10 }),
      );
    });
  });

  // ── GET /transactions/:id ──────────────────────────────────────────────────

  describe('GET /transactions/:id', () => {
    it('returns 200 and the transaction for the given id', async () => {
      const res = await request(app.getHttpServer())
        .get('/transactions/' + TX_ID)
        .expect(HttpStatus.OK);

      expect(res.body).toHaveProperty('id', TX_ID);

      const queryMock = app.get<jest.Mocked<TransactionQueryService>>(
        TransactionQueryService,
      );
      expect(queryMock.findOne).toHaveBeenCalledWith(TX_ID);
    });
  });

  // ── GET /transactions/wallet/:walletId ─────────────────────────────────────

  describe('GET /transactions/wallet/:walletId', () => {
    it('returns 200 and an array of transactions for the wallet', async () => {
      const res = await request(app.getHttpServer())
        .get('/transactions/wallet/' + WALLET_ID)
        .expect(HttpStatus.OK);

      expect(Array.isArray(res.body)).toBe(true);

      const queryMock = app.get<jest.Mocked<TransactionQueryService>>(
        TransactionQueryService,
      );
      expect(queryMock.findByWallet).toHaveBeenCalledWith(
        WALLET_ID,
        expect.anything(),
      );
    });
  });

  // ── GET /transactions/stellar/:hash ───────────────────────────────────────

  describe('GET /transactions/stellar/:hash', () => {
    it('returns 200 and the transaction for the given stellar hash', async () => {
      const res = await request(app.getHttpServer())
        .get('/transactions/stellar/' + STELLAR_HASH)
        .expect(HttpStatus.OK);

      expect(res.body).toHaveProperty('stellarHash', STELLAR_HASH);

      const queryMock = app.get<jest.Mocked<TransactionQueryService>>(
        TransactionQueryService,
      );
      expect(queryMock.findByStellarHash).toHaveBeenCalledWith(STELLAR_HASH);
    });
  });

  // ── PATCH /transactions/:id/status ────────────────────────────────────────

  describe('PATCH /transactions/:id/status', () => {
    it('returns 200 and the updated transaction entity', async () => {
      const res = await request(app.getHttpServer())
        .patch('/transactions/' + TX_ID + '/status')
        .send({ status: TransactionStatus.SUBMITTED })
        .expect(HttpStatus.OK);

      expect(res.body).toHaveProperty('status', TransactionStatus.SUBMITTED);

      const writeMock =
        app.get<jest.Mocked<TransactionsService>>(TransactionsService);
      expect(writeMock.updateStatus).toHaveBeenCalledWith(
        TX_ID,
        expect.objectContaining({ status: TransactionStatus.SUBMITTED }),
      );
    });
  });

  // ── Routing ────────────────────────────────────────────────────────────────

  describe('Routing — endpoint registration', () => {
    it('GET /transactions is registered (not 404)', async () => {
      const res = await request(app.getHttpServer()).get('/transactions');
      expect(res.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('POST /transactions is registered (not 404)', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions')
        .send({});
      expect(res.status).not.toBe(HttpStatus.NOT_FOUND);
    });

    it('POST /transactions/build is registered (not 404)', async () => {
      const res = await request(app.getHttpServer())
        .post('/transactions/build')
        .send({});
      expect(res.status).not.toBe(HttpStatus.NOT_FOUND);
    });
  });
});
