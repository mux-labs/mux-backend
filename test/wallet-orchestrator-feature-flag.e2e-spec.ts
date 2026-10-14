import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Wallet Orchestrator Feature Flag (e2e)', () => {
  let app: INestApplication;
  const originalFlag = process.env.FEATURE_WALLET_ORCHESTRATOR;

  beforeEach(async () => {
    process.env.FEATURE_WALLET_ORCHESTRATOR = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    if (originalFlag === undefined) {
      delete process.env.FEATURE_WALLET_ORCHESTRATOR;
    } else {
      process.env.FEATURE_WALLET_ORCHESTRATOR = originalFlag;
    }

    await app.close();
  });

  it('POST /v1/wallets/orchestration/create returns 403 when FEATURE_WALLET_ORCHESTRATOR=false', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/wallets/orchestration/create')
      .send({ userId: 'user-1', network: 'TESTNET' });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(response.body).toHaveProperty('message');
    expect(response.body.message).toMatch(/Feature is not available/i);
  });

  it('GET /v1/wallets/orchestration/user/:userId/:network returns 403 when FEATURE_WALLET_ORCHESTRATOR=false', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/wallets/orchestration/user/user-1/TESTNET');

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(response.body).toHaveProperty('message');
    expect(response.body.message).toMatch(/Feature is not available/i);
  });

  it('GET /v1/wallets/orchestration/validate/:userId/:network returns 403 when FEATURE_WALLET_ORCHESTRATOR=false', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/wallets/orchestration/validate/user-1/TESTNET');

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(response.body).toHaveProperty('message');
    expect(response.body.message).toMatch(/Feature is not available/i);
  });
});
