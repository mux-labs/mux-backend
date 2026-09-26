/**
 * E2E tests for wallet orchestration endpoints (#422)
 *
 * Covers:
 * - POST /wallets/orchestration/create
 * - GET  /wallets/orchestration/user/:userId/:network
 * - GET  /wallets/orchestration/validate/:userId/:network
 *
 * The orchestrator and guards are replaced with controlled stubs so no DB or
 * Stellar connection is required.
 */
import { Test } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { WalletCreationOrchestratorModule } from '../src/wallets/wallet-creation-orchestrator.module';
import { WalletCreationOrchestrator } from '../src/wallets/wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from '../src/wallets/domain/wallet.model';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { Reflector } from '@nestjs/core';
import { RequestIdInterceptor } from '../src/common/interceptors/request-id.interceptor';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-01T00:00:00.000Z').toISOString();

const makeWallet = (overrides: Record<string, any> = {}) => ({
  id: 'wallet-e2e-1',
  userId: 'user-e2e-1',
  publicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCD',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  network: WalletNetwork.TESTNET,
  status: WalletStatus.ACTIVE,
  statusReason: null,
  statusChangedAt: NOW,
  rotatedFromId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeOrchestrationResult = (overrides: Record<string, any> = {}) => ({
  wallet: makeWallet(),
  privateKey: 'secret-private-key',
  isNewWallet: true,
  idempotencyKey: undefined,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_API_KEY = 'mux_test_e2etestkey12345678901234567890';

const makeApiKeyService = (): Partial<ApiKeyService> => ({
  validateApiKey: jest.fn(async () => ({
    apiKey: { id: 'api-key-id' },
    project: { id: 'proj-id', name: 'proj-name' },
    developer: { id: 'dev-id', email: 'dev@example.com' },
  })),
  recordUsage: jest.fn(async () => {}),
});

async function buildApp(
  orchestratorOverrides: Partial<WalletCreationOrchestrator> = {},
  { featureFlagEnabled = true }: { featureFlagEnabled?: boolean } = {},
): Promise<INestApplication> {
  // The controller is gated by FEATURE_WALLET_ORCHESTRATOR (deny-by-default).
  // Enable it for the happy-path cases; the disabled case opts out explicitly.
  const previousFlag = process.env.FEATURE_WALLET_ORCHESTRATOR;
  if (featureFlagEnabled) {
    process.env.FEATURE_WALLET_ORCHESTRATOR = 'true';
  } else {
    delete process.env.FEATURE_WALLET_ORCHESTRATOR;
  }
  const mockOrchestrator: Partial<WalletCreationOrchestrator> = {
    createWallet: jest.fn(async () => makeOrchestrationResult()),
    getWalletByUser: jest.fn(async () => makeWallet()),
    validateUserCanCreateWallet: jest.fn(async () => true),
    ...orchestratorOverrides,
  };

  const mockApiKeyService = makeApiKeyService();

  const moduleRef = await Test.createTestingModule({
    imports: [WalletCreationOrchestratorModule],
  })
    .overrideProvider(WalletCreationOrchestrator)
    .useValue(mockOrchestrator)
    .overrideProvider(ApiKeyService)
    .useValue(mockApiKeyService)
    .compile();

  const app = moduleRef.createNestApplication();
  const originalClose = app.close.bind(app);
  // The app applies the version prefix globally; every route in this suite is
  // addressed as /v1/...
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  // Apply API key guard with a mock service that always passes
  // Echo the correlation id back so callers can correlate retries — critical
  // for the retry/replay path this suite covers.
  app.useGlobalInterceptors(new RequestIdInterceptor());
  const reflector = app.get(Reflector);
  app.useGlobalGuards(
    new ApiKeyGuard(mockApiKeyService as ApiKeyService, reflector),
  );
  await app.init();

  // Restore the ambient value so one case cannot leak the flag into another.
  app.close = (async () => {
    if (previousFlag === undefined) {
      delete process.env.FEATURE_WALLET_ORCHESTRATOR;
    } else {
      process.env.FEATURE_WALLET_ORCHESTRATOR = previousFlag;
    }
    return originalClose();
  }) as typeof app.close;

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wallet Orchestration Endpoints (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── POST /wallets/orchestration/create ──────────────────────────────────

  describe('POST /v1/wallets/orchestration/create', () => {
    it('returns 200 with wallet result on valid request', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .send({ userId: 'user-e2e-1', network: 'TESTNET' })
        .expect(HttpStatus.OK);

      expect(res.body).toMatchObject({
        wallet: { id: 'wallet-e2e-1', userId: 'user-e2e-1', network: 'TESTNET' },
        isNewWallet: true,
        privateKey: 'secret-private-key',
      });
    });

    it('propagates x-request-id header in response', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .set('x-request-id', 'e2e-req-001')
        .send({ userId: 'user-e2e-1', network: 'TESTNET' })
        .expect(HttpStatus.OK);

      expect(res.headers['x-request-id']).toBe('e2e-req-001');
    });

    it('returns 200 with idempotencyKey when provided', async () => {
      const idempotencyKey = 'idem-e2e-key-1';
      const localApp = await buildApp({
        createWallet: jest.fn(async () =>
          makeOrchestrationResult({ idempotencyKey }),
        ),
      });

      const res = await request(localApp.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .send({ userId: 'user-e2e-1', network: 'TESTNET', idempotencyKey })
        .expect(HttpStatus.OK);

      expect(res.body.idempotencyKey).toBe(idempotencyKey);
      await localApp.close();
    });

    it('returns 404 when user is not found', async () => {
      const localApp = await buildApp({
        createWallet: jest.fn(async () => {
          throw new NotFoundException('User not found');
        }),
      });

      await request(localApp.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .send({ userId: 'unknown-user', network: 'TESTNET' })
        .expect(HttpStatus.NOT_FOUND);

      await localApp.close();
    });

    it('returns 409 on idempotency key conflict', async () => {
      const localApp = await buildApp({
        createWallet: jest.fn(async () => {
          throw new ConflictException('Idempotency key conflict');
        }),
      });

      await request(localApp.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .send({ userId: 'user-e2e-1', network: 'TESTNET', idempotencyKey: 'conflict-key' })
        .expect(HttpStatus.CONFLICT);

      await localApp.close();
    });

    it('returns 401 without API key', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .send({ userId: 'user-e2e-1', network: 'TESTNET' })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('returns 403 when the feature flag is disabled (fail-closed)', async () => {
      // Deny-by-default: with FEATURE_WALLET_ORCHESTRATOR unset the guard
      // rejects the request before any orchestrator logic runs.
      const createWallet = jest.fn(async () => makeOrchestrationResult());
      const localApp = await buildApp(
        { createWallet },
        { featureFlagEnabled: false },
      );

      await request(localApp.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .send({ userId: 'user-e2e-1', network: 'TESTNET' })
        .expect(HttpStatus.FORBIDDEN);

      await localApp.close();
    });

    it('returns 503 when a dependency (RPC/DB) is unavailable (fail-closed)', async () => {
      const localApp = await buildApp({
        createWallet: jest.fn(async () => {
          throw new ServiceUnavailableException('Wallet backend unavailable');
        }),
      });

      await request(localApp.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .send({ userId: 'user-e2e-1', network: 'TESTNET' })
        .expect(HttpStatus.SERVICE_UNAVAILABLE);

      await localApp.close();
    });

    it('rejects oversized batch payloads with 400', async () => {
      await request(app.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .send({
          userId: 'user-e2e-1',
          network: 'TESTNET',
          unexpectedField: 'x'.repeat(10_000),
        })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  // ── GET /wallets/orchestration/user/:userId/:network ────────────────────

  describe('GET /v1/wallets/orchestration/user/:userId/:network', () => {
    it('returns wallet when found', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/wallets/orchestration/user/user-e2e-1/TESTNET')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .expect(HttpStatus.OK);

      expect(res.body).toMatchObject({
        id: 'wallet-e2e-1',
        userId: 'user-e2e-1',
        network: 'TESTNET',
      });
    });

    it('returns 404 when wallet is not found', async () => {
      const localApp = await buildApp({
        getWalletByUser: jest.fn(async () => null),
      });

      await request(localApp.getHttpServer())
        .get('/v1/wallets/orchestration/user/user-e2e-1/TESTNET')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .expect(HttpStatus.NOT_FOUND);

      await localApp.close();
    });

    it('returns 401 without API key', async () => {
      await request(app.getHttpServer())
        .get('/v1/wallets/orchestration/user/user-e2e-1/TESTNET')
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  // ── GET /wallets/orchestration/validate/:userId/:network ────────────────

  describe('GET /v1/wallets/orchestration/validate/:userId/:network', () => {
    it('returns canCreate=true when validation passes', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/wallets/orchestration/validate/user-e2e-1/TESTNET')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .expect(HttpStatus.OK);

      expect(res.body).toMatchObject({ canCreate: true });
    });

    it('returns canCreate=false when validation fails', async () => {
      const localApp = await buildApp({
        validateUserCanCreateWallet: jest.fn(async () => false),
      });

      const res = await request(localApp.getHttpServer())
        .get('/v1/wallets/orchestration/validate/user-e2e-1/TESTNET')
        .set('Authorization', `Bearer ${VALID_API_KEY}`)
        .expect(HttpStatus.OK);

      expect(res.body).toMatchObject({ canCreate: false });
      await localApp.close();
    });

    it('returns 401 without API key', async () => {
      await request(app.getHttpServer())
        .get('/v1/wallets/orchestration/validate/user-e2e-1/TESTNET')
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });
});
