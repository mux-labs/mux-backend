import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Wallet Orchestrator Feature Flag (e2e)', () => {
  let app: INestApplication;
  const originalFlag = process.env.FEATURE_WALLET_ORCHESTRATOR;

  const buildApp = async (): Promise<INestApplication> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const nestApp = moduleFixture.createNestApplication();
    // Apply the same `/v1` prefix that `src/main.ts` applies in production
    // (docs/API-VERSIONING.md). Without it the suite would probe unversioned
    // paths and get 404s instead of exercising the flag guard.
    nestApp.setGlobalPrefix('v1');
    await nestApp.init();
    return nestApp;
  };

  afterEach(async () => {
    if (originalFlag === undefined) {
      delete process.env.FEATURE_WALLET_ORCHESTRATOR;
    } else {
      process.env.FEATURE_WALLET_ORCHESTRATOR = originalFlag;
    }

    if (app) {
      await app.close();
    }
  });

  describe('when FEATURE_WALLET_ORCHESTRATOR=false (deny-by-default)', () => {
    beforeEach(async () => {
      process.env.FEATURE_WALLET_ORCHESTRATOR = 'false';
      app = await buildApp();
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
      const response = await request(app.getHttpServer()).get(
        '/v1/wallets/orchestration/user/user-1/TESTNET',
      );

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toMatch(/Feature is not available/i);
    });

    it('GET /v1/wallets/orchestration/validate/:userId/:network returns 403 when FEATURE_WALLET_ORCHESTRATOR=false', async () => {
      const response = await request(app.getHttpServer()).get(
        '/v1/wallets/orchestration/validate/user-1/TESTNET',
      );

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toMatch(/Feature is not available/i);
    });

    it('fails closed when the flag is unset (deny-by-default)', async () => {
      delete process.env.FEATURE_WALLET_ORCHESTRATOR;
      const unsetApp = await buildApp();
      try {
        const response = await request(unsetApp.getHttpServer())
          .post('/v1/wallets/orchestration/create')
          .send({ userId: 'user-1', network: 'TESTNET' });

        expect(response.status).toBe(HttpStatus.FORBIDDEN);
        expect(response.body).toHaveProperty('message');
        expect(response.body.message).toMatch(/Feature is not available/i);
      } finally {
        await unsetApp.close();
      }
    });
  });

  describe('when FEATURE_WALLET_ORCHESTRATOR=true (enabled)', () => {
    beforeEach(async () => {
      process.env.FEATURE_WALLET_ORCHESTRATOR = 'true';
      app = await buildApp();
    });

    it('POST /v1/wallets/orchestration/create is no longer blocked by the flag guard', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/wallets/orchestration/create')
        .send({ userId: 'user-1', network: 'TESTNET' });

      // The flag guard must not be the reason for rejection once enabled.
      expect(response.status).not.toBe(HttpStatus.FORBIDDEN);
      if (response.body && response.body.message) {
        expect(response.body.message).not.toMatch(/Feature is not available/i);
      }
    });

    it('GET /v1/wallets/orchestration/user/:userId/:network is no longer blocked by the flag guard', async () => {
      const response = await request(app.getHttpServer()).get(
        '/v1/wallets/orchestration/user/user-1/TESTNET',
      );

      expect(response.status).not.toBe(HttpStatus.FORBIDDEN);
      if (response.body && response.body.message) {
        expect(response.body.message).not.toMatch(/Feature is not available/i);
      }
    });

    it('GET /v1/wallets/orchestration/validate/:userId/:network is no longer blocked by the flag guard', async () => {
      const response = await request(app.getHttpServer()).get(
        '/v1/wallets/orchestration/validate/user-1/TESTNET',
      );

      expect(response.status).not.toBe(HttpStatus.FORBIDDEN);
      if (response.body && response.body.message) {
        expect(response.body.message).not.toMatch(/Feature is not available/i);
      }
    });
  });
});
