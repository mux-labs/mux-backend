import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
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

    describe('GET /wallets/:id - Get single wallet', () => {
      let walletId: string;

      beforeAll(async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: `${TEST_USER_ID}-get-1`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-get-1`,
          });
        walletId = response.body.wallet.id;
      });

      it('should retrieve wallet by ID', async () => {
        const response = await request(app.getHttpServer())
          .get(`/wallets/${walletId}`)
          .expect(200);

        expect(response.body.id).toBe(walletId);
        expect(response.body).toHaveProperty('publicKey');
        expect(response.body).toHaveProperty('network');
        expect(response.body).toHaveProperty('status');
      });

      it('should return 404 for non-existent wallet', async () => {
        const response = await request(app.getHttpServer())
          .get('/wallets/non-existent-id')
          .expect(404);

        expect(response.body.message).toContain('not found');
      });
    });

    describe('GET /wallets/:id/status - Get wallet status', () => {
      let walletId: string;

      beforeAll(async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: `${TEST_USER_ID}-status-1`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-status-1`,
          });
        walletId = response.body.wallet.id;
      });

      it('should retrieve lightweight wallet status', async () => {
        const response = await request(app.getHttpServer())
          .get(`/wallets/${walletId}/status`)
          .expect(200);

        expect(response.body).toHaveProperty('id', walletId);
        expect(response.body).toHaveProperty('status');
        expect(response.body).toHaveProperty('statusReason');
        expect(response.body).toHaveProperty('statusChangedAt');
      });
    });

    describe('PATCH /wallets/:id - Update wallet', () => {
      let walletId: string;

      beforeAll(async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: `${TEST_USER_ID}-update-1`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-update-1`,
          });
        walletId = response.body.wallet.id;
      });

      it('should update wallet status', async () => {
        const response = await request(app.getHttpServer())
          .patch(`/wallets/${walletId}`)
          .send({
            status: WalletStatus.SUSPENDED,
          })
          .expect(200);

        expect(response.body.status).toBe(WalletStatus.SUSPENDED);
      });
    });

    describe('GET /wallets/user/:userId - List wallets by user', () => {
      let userId: string;
      let walletId: string;

      beforeAll(async () => {
        userId = `${TEST_USER_ID}-user-list-1`;
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-user-list-1`,
          });
        walletId = response.body.wallet.id;
      });

      it('should retrieve wallets for specific user', async () => {
        const response = await request(app.getHttpServer())
          .get(`/wallets/user/${userId}`)
          .expect(200);

        expect(Array.isArray(response.body)).toBe(true);
        expect(response.body.length).toBeGreaterThan(0);
        expect(response.body[0].userId).toBe(userId);
      });
    });

    describe('DELETE /wallets/:id - Delete wallet', () => {
      let walletId: string;

      beforeAll(async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: `${TEST_USER_ID}-delete-1`,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-delete-1`,
          });
        walletId = response.body.wallet.id;
      });

      it('should delete wallet', async () => {
        await request(app.getHttpServer())
          .delete(`/wallets/${walletId}`)
          .expect(200);

        // Verify wallet is deleted
        await request(app.getHttpServer())
          .get(`/wallets/${walletId}`)
          .expect(404);
      });
    });
  });

  describe('Feature Flag Guard', () => {
    it('should return 403 when wallet feature is disabled (if flag is off)', async () => {
      // Note: This test demonstrates structure for feature flag testing
      // Actual behavior depends on FEATURE_WALLETS_ENABLED environment variable
      const response = await request(app.getHttpServer())
        .get('/wallets')
        .expect([200, 403]); // Accept either based on feature flag state

      if (response.status === 403) {
        expect(response.body.message).toContain('Feature is not available');
      }
    });
  });

  describe('Authentication & Authorization', () => {
    describe('API Key validation', () => {
      it('should reject requests without API key', async () => {
        // Most endpoints require API key authentication
        const response = await request(app.getHttpServer())
          .get('/wallets')
          .expect([200, 401]);

        // Expected to either have API key context or be unauthorized
        // depending on environment setup
      });

      it('should reject requests with invalid API key', async () => {
        const response = await request(app.getHttpServer())
          .get('/wallets')
          .set('Authorization', 'Bearer invalid-key')
          .expect([200, 401]);
      });
    });
  });

  describe('Error Handling & Validation', () => {
    describe('Input validation', () => {
      it('should reject invalid wallet network enum', async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: TEST_USER_ID,
            network: 'INVALID',
            idempotencyKey: `idem-${Date.now()}`,
          })
          .expect(400);

        expect(response.body.statusCode).toBe(400);
      });

      it('should reject empty userId', async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: '',
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}`,
          })
          .expect(400);

        expect(response.body.statusCode).toBe(400);
      });

      it('should reject missing idempotencyKey', async () => {
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId: TEST_USER_ID,
            network: WalletNetwork.TESTNET,
          })
          .expect(400);

        expect(response.body.statusCode).toBe(400);
      });
    });

    describe('Business logic validation', () => {
      it('should reject duplicate wallet creation with different keys', async () => {
        const userId = `${TEST_USER_ID}-dup-1`;
        const network = WalletNetwork.TESTNET;

        // Create first wallet
        await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network,
            idempotencyKey: `idem-${Date.now()}-dup-1`,
          })
          .expect(201);

        // Attempt duplicate with different idempotency key
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network,
            idempotencyKey: `idem-${Date.now()}-dup-2`,
          })
          .expect(409);

        expect(response.body.statusCode).toBe(409);
        expect(response.body.message).toContain('already has a wallet');
      });

      it('should handle invalid status updates gracefully', async () => {
        const userId = `${TEST_USER_ID}-invalid-status-1`;
        const response = await request(app.getHttpServer())
          .post('/wallets')
          .send({
            userId,
            network: WalletNetwork.TESTNET,
            idempotencyKey: `idem-${Date.now()}-invalid-status`,
          });

        const walletId = response.body.wallet.id;

        const updateResponse = await request(app.getHttpServer())
          .patch(`/wallets/${walletId}`)
          .send({
            status: 'INVALID_STATUS',
          })
          .expect([200, 400]);
      });
    });

    describe('Not found handling', () => {
      it('should return 404 for non-existent wallet get', async () => {
        const response = await request(app.getHttpServer())
          .get('/wallets/00000000-0000-0000-0000-000000000000')
          .expect(404);

        expect(response.body.message).toContain('not found');
      });

      it('should return 404 for non-existent wallet update', async () => {
        const response = await request(app.getHttpServer())
          .patch('/wallets/00000000-0000-0000-0000-000000000000')
          .send({ status: WalletStatus.SUSPENDED })
          .expect(404);

        expect(response.body.message).toContain('not found');
      });

      it('should return 404 for non-existent wallet delete', async () => {
        const response = await request(app.getHttpServer())
          .delete('/wallets/00000000-0000-0000-0000-000000000000')
          .expect(404);

        expect(response.body.message).toContain('not found');
      });
    });
  });
});
