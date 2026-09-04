import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

describe('Payment dry-run HTTP contract', () => {
  let app: INestApplication;
  const dryRun = jest.fn();
  const validateApiKey = jest.fn();

  beforeAll(async () => {
    validateApiKey.mockResolvedValue({
      apiKey: { id: 'api-key-id' },
      project: { id: 'project-id', rateLimitRpm: 100 },
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        ApiKeyGuard,
        Reflector,
        {
          provide: PaymentsService,
          useValue: {
            dryRun,
            create: jest.fn(),
            createBatch: jest.fn(),
            findAll: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: ApiKeyService,
          useValue: { validateApiKey, recordUsage: jest.fn() },
        },
      ],
    })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dryRun.mockReset();
  });

  it('returns a sanitized preview to an authorized caller', async () => {
    dryRun.mockResolvedValue({
      dryRun: true,
      valid: true,
      preview: {
        senderWalletId: 'sender-wallet',
        receiverWalletId: 'receiver-wallet',
        fromId: 1,
        toId: 2,
        amount: 25,
        currency: 'USD',
        status: 'PENDING',
      },
      checks: {
        senderWallet: 'ACTIVE',
        receiverWallet: 'FOUND',
        paymentLimits: 'PASSED',
      },
    });

    const response = await request(app.getHttpServer())
      .post('/v1/payments/dry-run')
      .set('Authorization', 'Bearer mux_test_valid')
      .send({
        walletId: 'sender-wallet',
        receiverWalletId: 'receiver-wallet',
        fromId: 1,
        toId: 2,
        amount: 25,
        currency: 'USD',
      })
      .expect(200);

    expect(response.body).toMatchObject({ dryRun: true, valid: true });
    expect(response.body).not.toHaveProperty('privateKey');
    expect(response.body).not.toHaveProperty('encryptedSecret');
    expect(dryRun).toHaveBeenCalledTimes(1);
  });

  it('returns the standard 400 response for invalid input', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/payments/dry-run')
      .set('Authorization', 'Bearer mux_test_valid')
      .send({
        walletId: 'sender-wallet',
        receiverWalletId: 'receiver-wallet',
        fromId: 1,
        toId: 2,
        amount: -1,
        currency: 'USD',
      })
      .expect(400);

    expect(response.body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
    });
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('returns the standard 401 response without authorization', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/payments/dry-run')
      .send({
        walletId: 'sender-wallet',
        receiverWalletId: 'receiver-wallet',
        fromId: 1,
        toId: 2,
        amount: 25,
        currency: 'USD',
      })
      .expect(401);

    expect(response.body).toMatchObject({
      statusCode: 401,
      message: 'API key is required',
      error: 'Unauthorized',
    });
    expect(dryRun).not.toHaveBeenCalled();
  });
});
