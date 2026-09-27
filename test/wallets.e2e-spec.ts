import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { WalletsModule } from '../src/wallets/wallets.module';
import { WalletsService } from '../src/wallets/wallets.service';
import { WalletCreationOrchestrator } from '../src/wallets/wallet-creation-orchestrator.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { Reflector } from '@nestjs/core';

describe('Wallets Protected Endpoint (e2e)', () => {
  let app: INestApplication;

  const validApiKey = 'mux_test_abc';

  const mockWalletsService: Partial<WalletsService> = {
    findAll: jest.fn(async () => []),
    getWalletStatus: jest.fn(async () => ({
      id: 'wallet-123',
      status: 'ACTIVE',
      statusReason: null,
      statusChangedAt: new Date(),
      network: 'TESTNET',
      publicKey: 'GABC123',
      userId: 'user-123',
      updatedAt: new Date(),
    })),
  };

  const mockWalletCreationOrchestrator: Partial<WalletCreationOrchestrator> = {
    createWallet: jest.fn(async () => ({
      wallet: { id: 'wallet-123', userId: 'user-123', publicKey: 'GABC123' },
      privateKey: 'secret-key',
      isNewWallet: true,
      idempotencyKey: 'idem-123',
    })),
  };

  const mockApiKeyService: Partial<ApiKeyService> = {
    validateApiKey: jest.fn(async (key: string) => {
      if (key !== validApiKey) {
        throw new Error('Invalid API key');
      }
      return {
        apiKey: { id: 'api-key-id' },
        project: { id: 'proj-id', name: 'proj-name' },
        developer: { id: 'dev-id', email: 'dev@example.com' },
      };
    }),
    recordUsage: jest.fn(async () => {}),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WalletsModule],
    })
      .overrideProvider(WalletsService)
      .useValue(mockWalletsService)
      .overrideProvider(WalletCreationOrchestrator)
      .useValue(mockWalletCreationOrchestrator)
      .overrideProvider(ApiKeyService)
      .useValue(mockApiKeyService)
      .compile();

    app = moduleRef.createNestApplication();

    // Apply guard globally so MVC routes are protected
    const reflector = app.get(Reflector);
    app.useGlobalGuards(
      new ApiKeyGuard(mockApiKeyService as ApiKeyService, reflector),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('/v1/wallets/protected (GET) with valid ApiKey returns 200 and context', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/wallets/protected')
      .set('Authorization', `ApiKey ${validApiKey}`)
      .expect(200);

    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('developer');
    expect(res.body).toHaveProperty('project');
  });

  it('/v1/wallets (POST) creates a wallet and returns x-request-id header', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/wallets')
      .set('Authorization', `ApiKey ${validApiKey}`)
      .set('x-request-id', 'req-456')
      .send({ userId: 'user-123', network: 'TESTNET', idempotencyKey: 'idem-123' })
      .expect(200);

    expect(res.headers['x-request-id']).toBe('req-456');
    expect(res.body).toMatchObject({
      wallet: { id: 'wallet-123', userId: 'user-123' },
      privateKey: 'secret-key',
      isNewWallet: true,
      idempotencyKey: 'idem-123',
    });
  });

  it('/v1/wallets/:id/status (GET) returns wallet status and propagates request id', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/wallets/wallet-123/status')
      .set('Authorization', `ApiKey ${validApiKey}`)
      .set('x-request-id', 'req-789')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('req-789');
    expect(res.body).toMatchObject({
      id: 'wallet-123',
      status: 'ACTIVE',
      userId: 'user-123',
    });
  });

  describe('authz negatives (fail-closed)', () => {
    it('rejects requests with no Authorization header', async () => {
      await request(app.getHttpServer())
        .get('/v1/wallets/protected')
        .expect(401);
    });

    it('rejects requests with a malformed Authorization scheme', async () => {
      await request(app.getHttpServer())
        .get('/v1/wallets/protected')
        .set('Authorization', 'Bearer mux_test_abc')
        .expect(401);
    });

    it('rejects requests with an invalid/revoked API key', async () => {
      await request(app.getHttpServer())
        .get('/v1/wallets/protected')
        .set('Authorization', 'ApiKey mux_revoked_key')
        .expect(401);
    });

    it('does not create a wallet when authz fails', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets')
        .set('Authorization', 'ApiKey mux_revoked_key')
        .send({ userId: 'user-123', network: 'TESTNET', idempotencyKey: 'idem-123' })
        .expect(401);

      expect(mockWalletCreationOrchestrator.createWallet).not.toHaveBeenCalled();
    });
  });

  describe('idempotency for replayed wallet creation', () => {
    it('forwards the idempotency key and returns the same wallet on replay', async () => {
      const payload = {
        userId: 'user-123',
        network: 'TESTNET',
        idempotencyKey: 'idem-replay-1',
      };

      const first = await request(app.getHttpServer())
        .post('/v1/wallets')
        .set('Authorization', `ApiKey ${validApiKey}`)
        .set('x-request-id', 'req-replay-1')
        .send(payload)
        .expect(200);

      const second = await request(app.getHttpServer())
        .post('/v1/wallets')
        .set('Authorization', `ApiKey ${validApiKey}`)
        .set('x-request-id', 'req-replay-2')
        .send(payload)
        .expect(200);

      expect(first.body.wallet.id).toBe(second.body.wallet.id);
      expect(first.body.idempotencyKey).toBe('idem-replay-1');
      expect(second.body.idempotencyKey).toBe('idem-replay-1');
      expect(mockWalletCreationOrchestrator.createWallet).toHaveBeenCalledTimes(2);
      expect(mockWalletCreationOrchestrator.createWallet).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'idem-replay-1' }),
      );
    });
  });
});
