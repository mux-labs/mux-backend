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
        .query({ page: 1, limit: 10, status: 'PENDING' })
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'PENDING' }),
        ]),
      );
    });

    it('should support pagination with custom limit', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/payments')
        .query({ page: 1, limit: 5 })
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body.limit).toBe(5);
    });

    it('should return empty list for non-existent status filter', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/payments')
        .query({ page: 1, limit: 10, status: 'NONEXISTENT' })
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body.data).toEqual([]);
    });
  });

  describe('GET /v1/payments/:id', () => {
    let paymentId: number;

    beforeAll(async () => {
      const payment = await prisma.payment.create({
        data: {
          fromId: userId,
          toId: userId,
          userId: userId,
          amount: 42,
          currency: 'USD',
          status: 'PENDING',
        },
      });
      paymentId = payment.id;
    });

    it('should return a payment by id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/v1/payments/${paymentId}`)
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('id', paymentId);
      expect(response.body).toHaveProperty('amount', 42);
    });

    it('should return 404 for non-existent payment', async () => {
      await request(app.getHttpServer())
        .get('/v1/payments/999999999')
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should require authentication', async () => {
      await request(app.getHttpServer())
        .get(`/v1/payments/${paymentId}`)
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });
});
