import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Auth Feature Flag (e2e)', () => {
  let app: INestApplication;
  const originalFlag = process.env.FEATURE_AUTH_API;
  const originalProvider = process.env.AUTH_PROVIDER;

  const buildApp = async (): Promise<INestApplication> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const nestApp = moduleFixture.createNestApplication();
    await nestApp.init();
    return nestApp;
  };

  afterEach(async () => {
    // Restore original environment
    if (originalFlag === undefined) {
      delete process.env.FEATURE_AUTH_API;
    } else {
      process.env.FEATURE_AUTH_API = originalFlag;
    }

    if (originalProvider === undefined) {
      delete process.env.AUTH_PROVIDER;
    } else {
      process.env.AUTH_PROVIDER = originalProvider;
    }

    if (app) {
      await app.close();
    }
  });

  describe('FEATURE_AUTH_API=false (kill-switch)', () => {
    beforeEach(async () => {
      // Ensure the feature flag is explicitly disabled for these tests
      process.env.FEATURE_AUTH_API = 'false';
      app = await buildApp();
    });

    it('POST /v1/auth/authenticate returns 403 when FEATURE_AUTH_API=false', async () => {
      const validAuthRequest = {
        authId: 'test-auth-id-flag-123',
        authProvider: 'CLERK',
        network: 'TESTNET',
      };

      const response = await request(app.getHttpServer())
        .post('/v1/auth/authenticate')
        .send(validAuthRequest);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toMatch(/Feature is not available/i);
    });

    it('GET /v1/auth/sessions returns 403 when FEATURE_AUTH_API=false', async () => {
      const response = await request(app.getHttpServer()).get('/v1/auth/sessions');

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toMatch(/Feature is not available/i);
    });
  });

  describe('AUTH_PROVIDER selection (Clerk vs Better Auth)', () => {
    beforeEach(async () => {
      process.env.FEATURE_AUTH_API = 'true';
    });

    it('defaults to CLERK when AUTH_PROVIDER is unset', async () => {
      delete process.env.AUTH_PROVIDER;
      app = await buildApp();

      const response = await request(app.getHttpServer())
        .post('/v1/auth/authenticate')
        .send({ authId: 'test-auth-id-default', authProvider: 'CLERK', network: 'TESTNET' });

      // Provider resolution must not fail closed with a config error when defaulting.
      expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(response.status).not.toBe(HttpStatus.FORBIDDEN);
    });

    it('accepts BETTER_AUTH as an explicit provider selection', async () => {
      process.env.AUTH_PROVIDER = 'BETTER_AUTH';
      app = await buildApp();

      const response = await request(app.getHttpServer())
        .post('/v1/auth/authenticate')
        .send({ authId: 'test-auth-id-better', authProvider: 'BETTER_AUTH', network: 'TESTNET' });

      expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(response.status).not.toBe(HttpStatus.FORBIDDEN);
    });

    it('denies-by-default on an unknown AUTH_PROVIDER value', async () => {
      process.env.AUTH_PROVIDER = 'NOT_A_REAL_PROVIDER';
      app = await buildApp();

      const response = await request(app.getHttpServer())
        .post('/v1/auth/authenticate')
        .send({ authId: 'test-auth-id-unknown', authProvider: 'CLERK', network: 'TESTNET' });

      // Fail-closed: unknown provider config must not silently fall through to a privileged path.
      expect([HttpStatus.FORBIDDEN, HttpStatus.BAD_REQUEST, HttpStatus.INTERNAL_SERVER_ERROR]).toContain(
        response.status,
      );
    });
  });
});
