/**
 * Network mismatch → stable `NETWORK_MISMATCH` error code (#943) — E2E tests.
 *
 * A key scoped to one network must never be able to act on another one, and
 * the refusal must happen in the guard — before the handler runs — so no write
 * is ever attempted against the wrong chain.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { WalletCreationOrchestratorModule } from '../src/wallets/wallet-creation-orchestrator.module';
import { WalletCreationOrchestrator } from '../src/wallets/wallet-creation-orchestrator.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyStatus } from '../src/api-keys/domain/api-key.model';
import { USER_STATUS_PORT } from '../src/users/user-status.service';

const API_KEY = 'mux_test_networkscope';

/**
 * The error envelope the guard produces. supertest types `response.body` as
 * `any`; naming the fields keeps the assertions honest and keeps the suite
 * honest under `no-unsafe-member-access`.
 */
interface ErrorBody {
  code?: string;
  message?: string;
  correlationId?: string;
  /** Present on a successful wallet-creation response. */
  isNewWallet?: boolean;
}

const bodyOf = (res: request.Response): ErrorBody => res.body as ErrorBody;

/** Builds a validated-key context scoped to `network` (null = all networks). */
function keyContext(network: 'TESTNET' | 'MAINNET' | null) {
  const now = new Date();
  return {
    apiKey: {
      id: 'key-scoped',
      name: 'scoped',
      keyHash: 'hashed',
      keyPrefix: 'mux_test_',
      lastFour: 'scope',
      projectId: 'proj-scope',
      network,
      status: ApiKeyStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    },
    project: {
      id: 'proj-scope',
      name: 'scope-project',
      environment: 'development',
      developerId: 'dev-scope',
      rateLimitRpm: 60,
    },
    developer: { id: 'dev-scope', email: 'dev@example.com' },
  };
}

async function buildApp(scopedTo: 'TESTNET' | 'MAINNET' | null) {
  process.env.FEATURE_WALLET_ORCHESTRATOR = 'true';
  // The real orchestrator encrypts the seed before returning it; the custody
  // key is only needed because these cases reach a successful mint.
  process.env.WALLET_ENCRYPTION_KEY ??= 'network-mismatch-e2e-key-32-chars!!';

  const validateApiKey = jest.fn(() => Promise.resolve(keyContext(scopedTo)));

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [WalletCreationOrchestratorModule],
  })
    .overrideProvider(ApiKeyService)
    .useValue({ validateApiKey, recordUsage: jest.fn(() => Promise.resolve()) })
    // Account status is out of scope here (#941 owns it); a permissive stub
    // keeps this suite free of a database dependency.
    .overrideProvider(USER_STATUS_PORT)
    .useValue({ assertCanTransact: jest.fn(() => Promise.resolve()) })
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  await app.init();

  return { app, validateApiKey };
}

describe('Network scope enforcement (#943)', () => {
  let app: INestApplication;
  const originalFlag = process.env.FEATURE_WALLET_ORCHESTRATOR;

  afterEach(async () => {
    if (originalFlag === undefined)
      delete process.env.FEATURE_WALLET_ORCHESTRATOR;
    else process.env.FEATURE_WALLET_ORCHESTRATOR = originalFlag;
    if (app) await app.close();
  });

  it('refuses a TESTNET-scoped key acting on MAINNET with NETWORK_MISMATCH', async () => {
    ({ app } = await buildApp('TESTNET'));

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: 'user-1', network: 'MAINNET' });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(bodyOf(response).code).toBe('NETWORK_MISMATCH');
    expect(bodyOf(response).message).toContain('TESTNET');
    expect(bodyOf(response).message).toContain('MAINNET');
    // Correlation id is echoed so the refusal can be traced.
    expect(bodyOf(response).correlationId).toBeDefined();
  });

  it('allows a TESTNET-scoped key acting on TESTNET', async () => {
    ({ app } = await buildApp('TESTNET'));

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: 'user-1', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.OK);
    expect(bodyOf(response).isNewWallet).toBe(true);
  });

  it('allows an unscoped key on any network (null = all networks)', async () => {
    ({ app } = await buildApp(null));

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: 'user-1', network: 'MAINNET' });

    expect(response.status).toBe(HttpStatus.OK);
  });

  it('honours an explicit x-mux-network header over the body', async () => {
    ({ app } = await buildApp('TESTNET'));

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('x-mux-network', 'MAINNET')
      .send({ userId: 'user-1', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(bodyOf(response).code).toBe('NETWORK_MISMATCH');
  });

  it('rejects an unrecognised network with INVALID_NETWORK (400)', async () => {
    ({ app } = await buildApp('TESTNET'));

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('x-mux-network', 'localnet')
      .send({ userId: 'user-1', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(bodyOf(response).code).toBe('INVALID_NETWORK');
  });

  it('denies an unauthenticated request before any network check', async () => {
    ({ app } = await buildApp('TESTNET'));

    await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .send({ userId: 'user-1', network: 'MAINNET' })
      .expect(HttpStatus.UNAUTHORIZED);
  });
});
