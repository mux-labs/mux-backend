import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Payments & Limits (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let apiKey: string;
  let projectId: string;
  let userId: number;
  let walletId: string;
  let receiverWalletId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    // Create test user and setup
    const user = await prisma.legacyUser.create({
      data: {
        email: `test-payment-user-${Date.now()}@example.com`,
        idempotencyKey: `user-${Date.now()}`,
      },
    });
    userId = user.id;

    // Create a project
    const project = await prisma.project.create({
      data: {
        name: `test-payment-project-${Date.now()}`,
        description: 'Test project for payments e2e',
      },
    });
    projectId = project.id;

    // Create API key
    const key = await prisma.apiKey.create({
      data: {
        projectId: project.id,
        name: 'test-payment-key',
        key: `pk_test_${Date.now()}`,
        secret: 'test-secret',
      },
    });
    apiKey = key.key;

    // Create wallets
    const wallet1 = await prisma.wallet.create({
      data: {
        userId: userId,
        address: `wallet-${Date.now()}-1`,
        network: 'TESTNET',
        status: 'ACTIVE',
      },
    });
    walletId = wallet1.id;

    const wallet2 = await prisma.wallet.create({
      data: {
        userId: userId,
        address: `wallet-${Date.now()}-2`,
        network: 'TESTNET',
        status: 'ACTIVE',
      },
    });
    receiverWalletId = wallet2.id;
  });

  afterAll(async () => {
    // Cleanup
    await prisma.payment.deleteMany({});
    await prisma.walletLimit.deleteMany({});
    await prisma.wallet.deleteMany({});
    await prisma.apiKey.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.legacyUser.deleteMany({});
    await app.close();
  });

  describe('POST /v1/payments', () => {
    it('should create a payment successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId,
          receiverWalletId,
          amount: 100,
          currency: 'USD',
          description: 'Test payment',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.CREATED);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('status', 'PENDING');
      expect(response.body).toHaveProperty('amount', 100);
      expect(response.body).toHaveProperty('currency', 'USD');
    });

    it('should reject payment with inactive wallet', async () => {
      const inactiveWallet = await prisma.wallet.create({
        data: {
          userId: userId,
          address: `wallet-${Date.now()}-inactive`,
          network: 'TESTNET',
          status: 'SUSPENDED',
        },
      });

      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId: inactiveWallet.id,
          receiverWalletId,
          amount: 50,
          currency: 'USD',
          description: 'Test payment',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.BAD_REQUEST);

      await prisma.wallet.delete({ where: { id: inactiveWallet.id } });
    });

    it('should reject payment exceeding per-transaction limit', async () => {
      // Set low per-transaction limit
      await prisma.walletLimit.create({
        data: {
          walletId,
          dailyLimit: 1000,
          perTransactionLimit: 50,
        },
      });

      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId,
          receiverWalletId,
          amount: 100,
          currency: 'USD',
          description: 'Test payment exceeding limit',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it('should reject payment exceeding daily limit', async () => {
      // Reset per-transaction limit high, set low daily limit
      await prisma.walletLimit.deleteMany({ where: { walletId } });
      await prisma.walletLimit.create({
        data: {
          walletId,
          dailyLimit: 150,
          perTransactionLimit: 1000,
        },
      });

      // First payment within daily limit
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId,
          receiverWalletId,
          amount: 100,
          currency: 'USD',
          description: 'First payment within daily limit',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.CREATED);

      // Second payment would exceed the daily limit
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId,
          receiverWalletId,
          amount: 100,
          currency: 'USD',
          description: 'Second payment exceeding daily limit',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it('should reject payment with missing required fields', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId,
          // Missing receiverWalletId
          amount: 50,
          currency: 'USD',
        })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('should reject payment with invalid amount', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId,
          receiverWalletId,
          amount: -50,
          currency: 'USD',
          description: 'Test payment',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.BAD_REQUEST);
    });

    it('should require authentication', async () => {
      await request(app.getHttpServer())
        .post('/v1/payments')
        .send({
          walletId,
          receiverWalletId,
          amount: 50,
          currency: 'USD',
          description: 'Test payment',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('GET /v1/payments', () => {
    let paymentId: number;

    beforeAll(async () => {
      // Create a payment for list tests
      const payment = await prisma.payment.create({
        data: {
          fromId: userId,
          toId: userId,
          userId: userId,
          amount: 75,
          currency: 'EUR',
          status: 'PENDING',
        },
      });
      paymentId = payment.id;
    });

    it('should list payments with pagination', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/payments')
        .query({ page: 1, limit: 10 })
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('page', 1);
      expect(response.body).toHaveProperty('limit', 10);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should filter payments by status', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/payments')
        .query({ status: 'PENDING' })
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should get a single payment by id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/v1/payments/${paymentId}`)
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('id', paymentId);
    });
  });

  describe('DELETE /v1/payments/:id (developer isolation)', () => {
    let ownerApiKey: string;
    let otherApiKey: string;
    let ownerPaymentId: number;

    beforeAll(async () => {
      // Developer A: project + key
      const projectA = await prisma.project.create({
        data: {
          name: `test-delete-project-a-${Date.now()}`,
          description: 'Owner project for delete isolation',
        },
      });
      const keyA = await prisma.apiKey.create({
        data: {
          projectId: projectA.id,
          name: 'test-delete-key-a',
          key: `pk_test_a_${Date.now()}`,
          secret: 'test-secret-a',
        },
      });
      ownerApiKey = keyA.key;

      // Developer B: project + key
      const projectB = await prisma.project.create({
        data: {
          name: `test-delete-project-b-${Date.now()}`,
          description: 'Other project for delete isolation',
        },
      });
      const keyB = await prisma.apiKey.create({
        data: {
          projectId: projectB.id,
          name: 'test-delete-key-b',
          key: `pk_test_b_${Date.now()}`,
          secret: 'test-secret-b',
        },
      });
      otherApiKey = keyB.key;

      // Developer A creates a payment
      const created = await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', ownerApiKey)
        .send({
          walletId,
          receiverWalletId,
          amount: 42,
          currency: 'USD',
          description: 'Owned payment for delete isolation',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.CREATED);

      ownerPaymentId = created.body.id;
    });

    it('should return 404 and not delete when another developer attempts DELETE', async () => {
      await request(app.getHttpServer())
        .delete(`/v1/payments/${ownerPaymentId}`)
        .set('X-API-Key', otherApiKey)
        .expect(HttpStatus.NOT_FOUND);

      const stillThere = await prisma.payment.findUnique({
        where: { id: ownerPaymentId },
      });
      expect(stillThere).not.toBeNull();
    });

    it('should delete the payment when the owning developer calls DELETE', async () => {
      await request(app.getHttpServer())
        .delete(`/v1/payments/${ownerPaymentId}`)
        .set('X-API-Key', ownerApiKey)
        .expect(HttpStatus.OK);

      const deleted = await prisma.payment.findUnique({
        where: { id: ownerPaymentId },
      });
      expect(deleted).toBeNull();
    });
  });
});
