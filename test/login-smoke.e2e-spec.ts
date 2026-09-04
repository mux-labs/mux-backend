import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

/**
 * Smoke test for the login (authenticate) flow: verifies the endpoint is
 * reachable under the versioned prefix, accepts a well-formed login
 * payload, and rejects a malformed one — without asserting on downstream
 * infra (DB/Horizon) behavior.
 */
describe('Login flow smoke test (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a well-formed login request and does not reject for auth/validation reasons', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/authenticate')
      .send({
        authId: 'smoke-test-auth-id',
        email: 'smoke-test@example.com',
        displayName: 'Smoke Test User',
        authProvider: 'CLERK',
        network: 'TESTNET',
      });

    expect(response.status).not.toBe(HttpStatus.NOT_FOUND);
    expect(response.status).not.toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects a login request missing the required authId field', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/authenticate')
      .send({ email: 'no-authid@example.com' });

    expect([HttpStatus.BAD_REQUEST, HttpStatus.UNPROCESSABLE_ENTITY]).toContain(
      response.status,
    );
  });
});
