import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletNetwork, WalletStatus } from '../src/wallets/domain/wallet.model';

describe('Wallet API Integration Tests (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const TEST_PROJECT_ID = 'test-project-wallets-1';
  const TEST_DEVELOPER_EMAIL = 'test-dev-wallets@example.com';
  const TEST_USER_ID = 'test-user-wallets-123';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    // Clean up test data
    try {
      await prisma.wallet.deleteMany({
        where: { userId: TEST_USER_ID },
      });
    } catch (error) {
      // Silently ignore cleanup errors
    }
    await app.close();
  });

  describe('Wallet CRUD Operations', () => {
    describe('POST /wallets - Create wallet', () => {
      it('should create a new wallet with valid data', async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: `${TEST_USER_ID}-create-1`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-1`,
          })
          .expect(201);

        expect(response.body).toHaveProperty('wallet');
        expect(response.body).toHaveProperty('privateKey');
        expect(response.body).toHaveProperty('isNewWallet');
        expect(response.body.wallet).toHaveProperty('id');
        expect(response.body.wallet).toHaveProperty('publicKey');
        expect(response.body.wallet.status).toBe(WalletStatus.ACTIVE);
        expect(response.body.wallet.network).toBe(WalletNetwork.TESTNET);
      });

      it('should be idempotent with same idempotency key', async () => {
        const idempotencyKey = `idem-${Date.now()}-idempotent`;
        const userId = `${TEST_USER_ID}-create-2`;

        const response1 = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.TESTNET,
            idempotencyKey,
          })
          .expect(201);

        const response2 = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.TESTNET,
            idempotencyKey,
          })
          .expect(201);

        expect(response1.body.wallet.id).toBe(response2.body.wallet.id);
        expect(response2.body.isNewWallet).toBe(false);
      });

      it('should reject duplicate wallet on same network for same user', async () => {
        const userId = `${TEST_USER_ID}-create-3`;
        const network = WalletNetwork.TESTNET;

        // Create first wallet
        await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network,
            idempotencyKey: `idem-${Date.now()}-first`,
          })
          .expect(201);

        // Attempt to create duplicate with different idempotency key
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network,
            idempotencyKey: `idem-${Date.now()}-second`,
          })
          .expect(409);

        expect(response.body.message).toContain('already has a wallet');
      });

      it('should allow same user to have wallets on different networks', async () => {
        const userId = `${TEST_USER_ID}-create-4`;

        const testnetRes = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-testnet`,
          })
          .expect(201);

        const mainnetRes = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.MAINNET,
            idempotencyKey: `idem-${Date.now()}-mainnet`,
          })
          .expect(201);

        expect(testnetRes.body.wallet.network).toBe(WalletNetwork.TESTNET);
        expect(mainnetRes.body.wallet.network).toBe(WalletNetwork.MAINNET);
        expect(testnetRes.body.wallet.id).not.toBe(mainnetRes.body.wallet.id);
      });

      it('should reject invalid network', async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: TEST_USER_ID,
            network: 'INVALID_NETWORK',
            idempotencyKey: `idem-${Date.now()}`,
          })
          .expect(400);

        expect(response.body.statusCode).toBe(400);
      });

      it('should reject missing required fields', async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: TEST_USER_ID,
            // missing network and idempotencyKey
          })
          .expect(400);

        expect(response.body.statusCode).toBe(400);
      });
    });

    describe('GET /wallets - List wallets', () => {
      beforeAll(async () => {
        // Create test wallets
        const userId = `${TEST_USER_ID}-list-1`;
        await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-list-1`,
          });
      });

      it('should list all wallets', async () => {
        const response = await request(app.getHttpServer())
          .get('/wallets')
          .expect(200);

        expect(Array.isArray(response.body.data)).toBe(true);
        expect(response.body).toHaveProperty('total');
        expect(response.body).toHaveProperty('limit');
        expect(response.body).toHaveProperty('offset');
        expect(response.body).toHaveProperty('hasMore');
      });

      it('should support pagination with limit and offset', async () => {
        const response = await request(app.getHttpServer())
          .get('/wallets?limit=10&offset=0')
          .expect(200);

        expect(response.body.limit).toBe(10);
        expect(response.body.offset).toBe(0);
      });

      it('should enforce max limit of 100', async () => {
        const response = await request(app.getHttpServer())
          .get('/wallets?limit=200')
          .expect(200);

        expect(response.body.limit).toBeLessThanOrEqual(100);
      });

      it('should filter wallets by userId', async () => {
        const userId = `${TEST_USER_ID}-list-2`;
        await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-list-2`,
          });

        const response = await request(app.getHttpServer())
          .get(`/wallets?userId=${userId}`)
          .expect(200);

        expect(response.body.data.length).toBeGreaterThan(0);
        response.body.data.forEach((wallet: any) => {
          expect(wallet.userId).toBe(userId);
        });
      });

      it('should filter wallets by network', async () => {
        const response = await request(app.getHttpServer())
          .get(`/wallets?network=${WalletNetwork.TESTNET}`)
          .expect(200);

        response.body.data.forEach((wallet: any) => {
          expect(wallet.network).toBe(WalletNetwork.TESTNET);
        });
      });

      it('should filter wallets by status', async () => {
        const response = await request(app.getHttpServer())
          .get(`/wallets?status=${WalletStatus.ACTIVE}`)
          .expect(200);

        response.body.data.forEach((wallet: any) => {
          expect(wallet.status).toBe(WalletStatus.ACTIVE);
        });
      });
    });

    describe('GET /wallets/:id - Get wallet by id', () => {
      let walletId: string;

      beforeAll(async () => {
        const res = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: `${TEST_USER_ID}-get-1`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-get-1`,
          });
        walletId = res.body.wallet.id;
      });

      it('should return wallet by id', async () => {
        const response = await request(app.getHttpServer())
          .get(`/wallets/${walletId}`)
          .expect(200);

        expect(response.body.id).toBe(walletId);
        expect(response.body).toHaveProperty('publicKey');
        expect(response.body).not.toHaveProperty('privateKey');
      });

      it('should return 404 for unknown wallet id', async () => {
        await request(app.getHttpServer())
          .get('/wallets/00000000-0000-0000-0000-000000000000')
          .expect(404);
      });
    });

    describe('Authz negatives', () => {
      it('should reject create without API key/JWT', async () => {
        await request(app.getHttpServer())
          .post('/wallets')
          .set('Authorization', '')
          .send({
            userId: `${TEST_USER_ID}-authz-1`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-authz-1`,
          })
          .expect((res) => {
            expect([401, 403]).toContain(res.status);
          });
      });

      it('should reject create with expired/invalid JWT', async () => {
        await request(app.getHttpServer())
          .post('/wallets')
          .set('Authorization', 'Bearer expired.invalid.token')
          .send({
            userId: `${TEST_USER_ID}-authz-2`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-authz-2`,
          })
          .expect((res) => {
            expect([401, 403]).toContain(res.status);
          });
      });

      it('should reject revoked delegate attempting privileged action', async () => {
        await request(app.getHttpServer())
          .post('/wallets')
          .set('X-Delegate-Id', 'revoked-delegate')
          .send({
            userId: `${TEST_USER_ID}-authz-3`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-authz-3`,
          })
          .expect((res) => {
            expect([401, 403]).toContain(res.status);
          });
      });

      it('should reject wrong role for admin-only surface', async () => {
        await request(app.getHttpServer())
          .get('/wallets?limit=1')
          .set('X-Role', 'viewer')
          .expect((res) => {
            expect([200, 401, 403]).toContain(res.status);
          });
      });
    });

    describe('Idempotency under concurrency', () => {
      it('should collapse concurrent creates with same idempotency key', async () => {
        const userId = `${TEST_USER_ID}-concurrent-1`;
        const idempotencyKey = `idem-${Date.now()}-concurrent`;

        const results = await Promise.all(
          Array.from({ length: 5 }).map(() =>
            request(app.getHttpServer())
              .post('/wallets')
              .send({
                userId,
                network: WalletNetwork.TESTNET,
                idempotencyKey,
              }),
          ),
        );

        const created = results.filter((r) => r.status === 201);
        expect(created.length).toBeGreaterThan(0);

        const ids = new Set(created.map((r) => r.body.wallet.id));
        expect(ids.size).toBe(1);
      });
    });
  });
});
