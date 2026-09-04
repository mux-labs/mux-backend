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
          amount: 125,
          currency: 'GBP',
          status: 'CONFIRMED',
        },
      });
      paymentId = payment.id;
    });

    it('should retrieve a specific payment', async () => {
      const response = await request(app.getHttpServer())
        .get(`/v1/payments/${paymentId}`)
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('id', paymentId);
      expect(response.body).toHaveProperty('amount', 125);
      expect(response.body).toHaveProperty('currency', 'GBP');
    });

    it('should return 404 for non-existent payment', async () => {
      await request(app.getHttpServer())
        .get('/v1/payments/999999')
        .set('X-API-Key', apiKey)
        .expect(HttpStatus.NOT_FOUND);
    });
  });

  describe('PATCH /v1/payments/:id', () => {
    let paymentId: number;

    beforeAll(async () => {
      const payment = await prisma.payment.create({
        data: {
          fromId: userId,
          toId: userId,
          userId: userId,
          amount: 200,
          currency: 'USD',
          status: 'PENDING',
        },
      });
      paymentId = payment.id;
    });

    it('should update a pending payment status to CONFIRMED', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/v1/payments/${paymentId}`)
        .set('X-API-Key', apiKey)
        .send({ status: 'CONFIRMED' })
        .expect(HttpStatus.OK);

      expect(response.body).toHaveProperty('status', 'CONFIRMED');
    });

    it('should reject invalid status transition', async () => {
      const payment = await prisma.payment.create({
        data: {
          fromId: userId,
          toId: userId,
          userId: userId,
          amount: 150,
          currency: 'USD',
          status: 'FAILED',
        },
      });

      await request(app.getHttpServer())
        .patch(`/v1/payments/${payment.id}`)
        .set('X-API-Key', apiKey)
        .send({ status: 'PENDING' })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('Limits Management', () => {
    describe('POST /v1/limits', () => {
      it('should set spending limits for a wallet', async () => {
        const response = await request(app.getHttpServer())
          .post('/v1/limits')
          .set('X-API-Key', apiKey)
          .send({
            walletId,
            dailyLimit: 5000,
            perTransactionLimit: 1000,
          })
          .expect(HttpStatus.CREATED);

        expect(response.body).toHaveProperty('walletId', walletId);
        expect(response.body).toHaveProperty('dailyLimit', 5000);
        expect(response.body).toHaveProperty('perTransactionLimit', 1000);
      });

      it('should reject invalid limit values', async () => {
        await request(app.getHttpServer())
          .post('/v1/limits')
          .set('X-API-Key', apiKey)
          .send({
            walletId,
            dailyLimit: -1000,
            perTransactionLimit: 500,
          })
          .expect(HttpStatus.BAD_REQUEST);
      });

      it('should require authentication', async () => {
        await request(app.getHttpServer())
          .post('/v1/limits')
          .send({
            walletId,
            dailyLimit: 5000,
            perTransactionLimit: 1000,
          })
          .expect(HttpStatus.UNAUTHORIZED);
      });
    });

    describe('GET /v1/limits/:walletId', () => {
      it('should retrieve limits for a wallet', async () => {
        // Create limits first
        await prisma.walletLimit.create({
          data: {
            walletId: receiverWalletId,
            dailyLimit: 3000,
            perTransactionLimit: 500,
          },
        });

        const response = await request(app.getHttpServer())
          .get(`/v1/limits/${receiverWalletId}`)
          .set('X-API-Key', apiKey)
          .expect(HttpStatus.OK);

        expect(response.body).toHaveProperty('walletId', receiverWalletId);
        expect(response.body).toHaveProperty('dailyLimit', 3000);
        expect(response.body).toHaveProperty('perTransactionLimit', 500);
      });

      it('should return 404 for wallet without limits', async () => {
        const tempWallet = await prisma.wallet.create({
          data: {
            userId: userId,
            address: `wallet-${Date.now()}-temp`,
            network: 'TESTNET',
            status: 'ACTIVE',
          },
        });

        await request(app.getHttpServer())
          .get(`/v1/limits/${tempWallet.id}`)
          .set('X-API-Key', apiKey)
          .expect(HttpStatus.NOT_FOUND);

        await prisma.wallet.delete({ where: { id: tempWallet.id } });
      });
    });

    describe('PUT /v1/limits/:walletId', () => {
      let limitedWallet: any;

      beforeAll(async () => {
        limitedWallet = await prisma.wallet.create({
          data: {
            userId: userId,
            address: `wallet-${Date.now()}-update`,
            network: 'TESTNET',
            status: 'ACTIVE',
          },
        });

        await prisma.walletLimit.create({
          data: {
            walletId: limitedWallet.id,
            dailyLimit: 2000,
            perTransactionLimit: 400,
          },
        });
      });

      afterAll(async () => {
        await prisma.walletLimit.deleteMany({
          where: { walletId: limitedWallet.id },
        });
        await prisma.wallet.delete({ where: { id: limitedWallet.id } });
      });

      it('should update spending limits', async () => {
        const response = await request(app.getHttpServer())
          .put(`/v1/limits/${limitedWallet.id}`)
          .set('X-API-Key', apiKey)
          .send({
            dailyLimit: 7000,
            perTransactionLimit: 1500,
          })
          .expect(HttpStatus.OK);

        expect(response.body).toHaveProperty('dailyLimit', 7000);
        expect(response.body).toHaveProperty('perTransactionLimit', 1500);
      });
    });

    describe('DELETE /v1/limits/:walletId', () => {
      it('should remove spending limits', async () => {
        const tempWallet = await prisma.wallet.create({
          data: {
            userId: userId,
            address: `wallet-${Date.now()}-delete`,
            network: 'TESTNET',
            status: 'ACTIVE',
          },
        });

        await prisma.walletLimit.create({
          data: {
            walletId: tempWallet.id,
            dailyLimit: 1000,
            perTransactionLimit: 200,
          },
        });

        await request(app.getHttpServer())
          .delete(`/v1/limits/${tempWallet.id}`)
          .set('X-API-Key', apiKey)
          .expect(HttpStatus.OK);

        const limits = await prisma.walletLimit.findUnique({
          where: { walletId: tempWallet.id },
        });

        expect(limits).toBeNull();

        await prisma.wallet.delete({ where: { id: tempWallet.id } });
      });

      it('should return 404 when removing non-existent limits', async () => {
        const tempWallet = await prisma.wallet.create({
          data: {
            userId: userId,
            address: `wallet-${Date.now()}-no-limits`,
            network: 'TESTNET',
            status: 'ACTIVE',
          },
        });

        await request(app.getHttpServer())
          .delete(`/v1/limits/${tempWallet.id}`)
          .set('X-API-Key', apiKey)
          .expect(HttpStatus.NOT_FOUND);

        await prisma.wallet.delete({ where: { id: tempWallet.id } });
      });
    });
  });

  describe('Daily Limit Enforcement', () => {
    it('should enforce daily spending limits', async () => {
      const tempWallet = await prisma.wallet.create({
        data: {
          userId: userId,
          address: `wallet-${Date.now()}-daily`,
          network: 'TESTNET',
          status: 'ACTIVE',
        },
      });

      const receiverWallet = await prisma.wallet.create({
        data: {
          userId: userId,
          address: `wallet-${Date.now()}-receiver-daily`,
          network: 'TESTNET',
          status: 'ACTIVE',
        },
      });

      // Set daily limit
      await prisma.walletLimit.create({
        data: {
          walletId: tempWallet.id,
          dailyLimit: 100,
          perTransactionLimit: 100,
        },
      });

      // First payment within limit
      const payment1 = await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId: tempWallet.id,
          receiverWalletId: receiverWallet.id,
          amount: 60,
          currency: 'USD',
          description: 'First payment',
          fromId: userId,
          toId: userId,
        });

      expect(payment1.status).toBe(HttpStatus.CREATED);

      // Second payment exceeding daily limit
      await request(app.getHttpServer())
        .post('/v1/payments')
        .set('X-API-Key', apiKey)
        .send({
          walletId: tempWallet.id,
          receiverWalletId: receiverWallet.id,
          amount: 60,
          currency: 'USD',
          description: 'Second payment',
          fromId: userId,
          toId: userId,
        })
        .expect(HttpStatus.UNPROCESSABLE_ENTITY);

      await prisma.walletLimit.deleteMany({
        where: { walletId: tempWallet.id },
      });
      await prisma.wallet.delete({ where: { id: tempWallet.id } });
      await prisma.wallet.delete({ where: { id: receiverWallet.id } });
    });
  });
});
