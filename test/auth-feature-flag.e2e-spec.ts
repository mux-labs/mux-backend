import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Auth Feature Flag (e2e)', () => {
  let app: INestApplication;
  const originalFlag = process.env.FEATURE_AUTH_API;

  beforeEach(async () => {
    // Ensure the feature flag is explicitly disabled for these tests
    process.env.FEATURE_AUTH_API = 'false';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    // Restore original environment
    if (originalFlag === undefined) {
      delete process.env.FEATURE_AUTH_API;
    } else {
      process.env.FEATURE_AUTH_API = originalFlag;
    }

    await app.close();
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
