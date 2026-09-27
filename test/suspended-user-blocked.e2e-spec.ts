/**
 * A suspended user cannot create a wallet (#941) — E2E tests.
 *
 * The `UserStatus` enum exists (migration
 * `20260831000001_add_user_status_enum`); these tests pin the enforcement:
 * the orchestration path consults the account status before any key material
 * is minted and refuses with a stable error code. Dependency outages fail
 * closed with 503 rather than letting the write through.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  INestApplication,
  ServiceUnavailableException,
  HttpStatus,
} from '@nestjs/common';
import request from 'supertest';
import { WalletCreationOrchestratorModule } from '../src/wallets/wallet-creation-orchestrator.module';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { USER_STATUS_PORT } from '../src/users/user-status.service';

const API_KEY = 'mux_test_suspendeduser';

/**
 * The response envelope. supertest types `response.body` as `any`; naming the
 * fields keeps the assertions honest and honest under `no-unsafe-member-access`.
 */
interface ResponseBody {
  code?: string;
  message?: string;
  correlationId?: string;
  isNewWallet?: boolean;
  canCreate?: boolean;
}

const bodyOf = (res: request.Response): ResponseBody => res.body as ResponseBody;

/** Status lookup stub keyed by user id. `undefined` means "store outage". */
function makeUserStatus(statusByUserId: Record<string, string | undefined>) {
  const assertCanTransact = jest.fn(
    async (userId: string, operation: string, correlationId?: string) => {
      const status = statusByUserId[userId];
      if (status === undefined) {
        throw new ServiceUnavailableException({
          code: 'USER_STATUS_UNAVAILABLE',
          message: 'User status could not be verified',
          correlationId,
        });
      }
      if (status === 'SUSPENDED' || status === 'DISABLED') {
        throw new ForbiddenException({
          code: status === 'SUSPENDED' ? 'USER_SUSPENDED' : 'USER_DISABLED',
          message: `User ${userId} cannot perform ${operation}: account status is ${status}`,
          correlationId,
        });
      }
    },
  );
  return { assertCanTransact };
}

async function buildApp(userStatus: Record<string, string | undefined>) {
  process.env.FEATURE_WALLET_ORCHESTRATOR = 'true';
  process.env.WALLET_ENCRYPTION_KEY ??= 'suspended-user-e2e-key-32-chars!!';

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [WalletCreationOrchestratorModule],
  })
    .overrideProvider(ApiKeyService)
    .useValue({
      validateApiKey: jest.fn(() =>
        Promise.resolve({
        apiKey: { id: 'key-1', network: null },
        project: { id: 'proj-1', name: 'proj', rateLimitRpm: 60 },
        developer: { id: 'dev-1', email: 'dev@example.com' },
      })),
      recordUsage: jest.fn(() => Promise.resolve()),
    })
    .overrideProvider(USER_STATUS_PORT)
    .useValue(makeUserStatus(userStatus))
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  await app.init();

  return app;
}

describe('Suspended user cannot create a wallet (#941)', () => {
  let app: INestApplication;
  const originalFlag = process.env.FEATURE_WALLET_ORCHESTRATOR;

  afterEach(async () => {
    if (originalFlag === undefined)
      delete process.env.FEATURE_WALLET_ORCHESTRATOR;
    else process.env.FEATURE_WALLET_ORCHESTRATOR = originalFlag;
    if (app) await app.close();
  });

  it('creates a wallet for an ACTIVE user', async () => {
    app = await buildApp({ 'user-active': 'ACTIVE' });

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: 'user-active', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.OK);
    expect(bodyOf(response).isNewWallet).toBe(true);
  });

  it('refuses a SUSPENDED user with 403 USER_SUSPENDED', async () => {
    app = await buildApp({ 'user-suspended': 'SUSPENDED' });

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('x-request-id', 'req-suspended-1')
      .send({ userId: 'user-suspended', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(bodyOf(response).code).toBe('USER_SUSPENDED');
    expect(bodyOf(response).correlationId).toBe('req-suspended-1');
  });

  it('refuses a DISABLED user with 403 USER_DISABLED', async () => {
    app = await buildApp({ 'user-disabled': 'DISABLED' });

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: 'user-disabled', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(bodyOf(response).code).toBe('USER_DISABLED');
  });

  it('mints no wallet for a refused user', async () => {
    app = await buildApp({ 'user-suspended': 'SUSPENDED' });

    await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: 'user-suspended', network: 'TESTNET' })
      .expect(HttpStatus.FORBIDDEN);

    // Nothing was created: the user still has no wallet on this network.
    const validation = await request(app.getHttpServer())
      .get('/v1/wallets/orchestration/validate/user-suspended/TESTNET')
      .set('Authorization', `Bearer ${API_KEY}`);

    expect(validation.status).toBe(HttpStatus.OK);
    expect(bodyOf(validation).canCreate).toBe(true);
  });

  it('fails closed (503) when the status store is unavailable', async () => {
    app = await buildApp({ 'user-unknown': undefined });

    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({ userId: 'user-unknown', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(bodyOf(response).code).toBe('USER_STATUS_UNAVAILABLE');
  });

  it('still requires an API key before any status check', async () => {
    app = await buildApp({ 'user-suspended': 'SUSPENDED' });

    await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .send({ userId: 'user-suspended', network: 'TESTNET' })
      .expect(HttpStatus.UNAUTHORIZED);
  });
});
