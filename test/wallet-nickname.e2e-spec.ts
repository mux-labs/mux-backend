import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WalletsController } from '../src/wallets/wallets.controller';
import { WalletsService } from '../src/wallets/wallets.service';
import { WalletCreationOrchestrator } from '../src/wallets/wallet-creation-orchestrator.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { FeatureFlagService } from '../src/common/feature-flags/feature-flag.service';
import { FeatureFlagGuard } from '../src/common/feature-flags/feature-flag.guard';
import { RateLimitService } from '../src/rate-limit/rate-limit.service';
import { RateLimitGuard } from '../src/rate-limit/rate-limit.guard';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

/**
 * e2e for PATCH /v1/wallets/:id/nickname.
 *
 * Mounts only the wallet controller (plus the guards it uses) so the test does
 * not pull in the full application module graph. The real
 * WalletsService.updateNickname runs over a mocked Prisma, so sanitization and
 * per-owner uniqueness are exercised end-to-end through the HTTP boundary.
 */
describe('WalletsController nickname (e2e)', () => {
  let app: INestApplication;

  const baseWallet = {
    id: 'wallet-1',
    userId: 'user-1',
    publicKey: 'GPUBKEY1',
    encryptedSecret: 'enc',
    encryptionVersion: 1,
    secretVersion: 1,
    keyVersion: 1,
    network: 'TESTNET',
    status: 'ACTIVE',
    statusReason: null,
    statusChangedAt: new Date(),
    rotatedFromId: null,
    successorId: null,
    nickname: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrisma = {
    wallet: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };

  const serviceObject = {
    prisma: mockPrisma,
    logger: {
      logWithContext: jest.fn(),
      warnWithContext: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    mapPrismaWalletToDomain: (w: any) => ({
      ...w,
      network: w.network,
      status: w.status,
      nickname: w.nickname ?? null,
    }),
    toPublicWallet: (w: any) => {
      const { encryptedSecret: _enc, ...pub } = w;
      return pub;
    },
    updateNickname: WalletsService.prototype.updateNickname,
    sanitizeNickname: (WalletsService.prototype as any).sanitizeNickname,
    recordMetric: jest.fn(),
  };

  const apiKeyStub = {
    validateApiKey: jest.fn(async () => ({
      apiKey: { id: 'api-key-id', network: undefined },
      project: { id: 'proj-id', name: 'proj-name', rateLimitRpm: 60 },
      developer: { id: 'dev-id', email: 'dev@example.com' },
    })),
    recordUsage: jest.fn(async () => {}),
  };

  const flagStub = { isEnabled: jest.fn(() => true) };
  const rateLimitStub = {
    checkRateLimit: jest.fn(async () => ({
      allowed: true,
      remaining: 100,
      resetTime: new Date(),
      limit: 100,
    })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        FeatureFlagGuard,
        ApiKeyGuard,
        RateLimitGuard,
        { provide: FeatureFlagService, useValue: flagStub },
        { provide: ApiKeyService, useValue: apiKeyStub },
        { provide: RateLimitService, useValue: rateLimitStub },
        { provide: WalletsService, useValue: serviceObject },
        {
          provide: WalletCreationOrchestrator,
          useValue: { createWallet: jest.fn() },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalGuards(
      new ApiKeyGuard(apiKeyStub as any, reflector),
      new FeatureFlagGuard(flagStub as any, reflector),
      new RateLimitGuard(rateLimitStub as any, reflector),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Defaults: the wallet exists and no duplicate nickname is owned.
    mockPrisma.wallet.findUnique.mockResolvedValue(baseWallet);
    mockPrisma.wallet.findFirst.mockResolvedValue(null);
  });

  const nickUrl = () => '/v1/wallets/wallet-1/nickname';

  it('sanitizes HTML before persisting and returns a tag-free label', async () => {
    const sanitized = 'alert(1) Savings'; // tags stripped, plain text preserved
    mockPrisma.wallet.update.mockResolvedValue({
      ...baseWallet,
      nickname: sanitized,
      updatedAt: new Date(),
    });

    const res = await request(app.getHttpServer())
      .patch(nickUrl())
      .set('Authorization', 'ApiKey mux_test_abc')
      .set('x-request-id', 'req-nick-1')
      .send({ nickname: '<script>alert(1)</script>Savings' })
      .expect(200);

    expect(res.body.nickname).toBe(sanitized);
    expect(res.body.nickname).not.toMatch(/[<>]/);
    expect(res.body.nickname).not.toContain('script');
    // the sanitized value is what was written to the store
    const written = mockPrisma.wallet.update.mock.calls[0][0].data.nickname;
    expect(written).toBe(sanitized);
    // request id propagated into structured logs
    expect(serviceObject.logger.logWithContext).toHaveBeenCalledWith(
      'Updated wallet nickname',
      expect.objectContaining({
        operation: 'update_nickname',
        requestId: 'req-nick-1',
        outcome: 'success',
      }),
    );
  });

  it('rejects a nickname already used by another wallet the same user owns', async () => {
    mockPrisma.wallet.findFirst.mockResolvedValue({
      ...baseWallet,
      id: 'wallet-2',
      nickname: 'Savings',
    });

    const res = await request(app.getHttpServer())
      .patch(nickUrl())
      .set('Authorization', 'ApiKey mux_test_abc')
      .set('x-request-id', 'req-nick-conflict')
      .send({ nickname: 'Savings' })
      .expect(409);

    expect(res.body.message).toContain('already in use');
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
  });

  it('clears a nickname without running the uniqueness check', async () => {
    mockPrisma.wallet.update.mockResolvedValue({
      ...baseWallet,
      nickname: null,
      updatedAt: new Date(),
    });

    const res = await request(app.getHttpServer())
      .patch(nickUrl())
      .set('Authorization', 'ApiKey mux_test_abc')
      .send({ nickname: null })
      .expect(200);

    expect(res.body.nickname).toBeNull();
    expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  it('treats an input that sanitizes to empty as a clear', async () => {
    mockPrisma.wallet.update.mockResolvedValue({
      ...baseWallet,
      nickname: null,
      updatedAt: new Date(),
    });

    const res = await request(app.getHttpServer())
      .patch(nickUrl())
      .set('Authorization', 'ApiKey mux_test_abc')
      .send({ nickname: '<img src=x onerror=alert(1)>' })
      .expect(200);

    expect(res.body.nickname).toBeNull();
    expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
  });
});