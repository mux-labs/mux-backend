import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';

import { IdempotentUserController } from './idempotent-user.controller';
import { IdempotentUserService } from './idempotent-user.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';

/**
 * Proves the security property asserted by the comment in
 * `idempotent-user.module.ts`: the idempotent-user surface is protected by the
 * real `ApiKeyGuard`, so revoking an API key takes effect immediately.
 *
 * The guard is exercised for real (not stubbed); only `ApiKeyService` is mocked,
 * mirroring the approach in `src/api-keys/api-key.guard.spec.ts`.
 */
describe('IdempotentUserController (ApiKeyGuard integration)', () => {
  let app: INestApplication;

  const findOrCreate = jest.fn();

  // Mutable key store so a test can flip a key to revoked between calls.
  const keys = new Map<string, { id: string; status: string }>();

  const apiKeyService = {
    validateApiKey: jest.fn(async (rawKey: string) => {
      const record = keys.get(rawKey);
      if (!record || record.status !== 'active') {
        throw new UnauthorizedException('Invalid API key');
      }
      return record;
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IdempotentUserController],
      providers: [
        { provide: IdempotentUserService, useValue: { findOrCreate } },
        { provide: ApiKeyService, useValue: apiKeyService },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    keys.clear();
    keys.set('valid-key', { id: 'key-1', status: 'active' });
    findOrCreate.mockResolvedValue({ id: 'user-1' });
  });

  it('rejects a request with no API key', async () => {
    await request(app.getHttpServer())
      .post('/users/find-or-create')
      .send({ email: 'a@example.com' })
      .expect(401);

    expect(findOrCreate).not.toHaveBeenCalled();
  });

  it('allows a request with a valid API key to reach the handler', async () => {
    await request(app.getHttpServer())
      .post('/users/find-or-create')
      .set('x-api-key', 'valid-key')
      .send({ email: 'a@example.com' })
      .expect(201);

    expect(findOrCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects the immediately following request once the key is revoked', async () => {
    await request(app.getHttpServer())
      .post('/users/find-or-create')
      .set('x-api-key', 'valid-key')
      .send({ email: 'a@example.com' })
      .expect(201);

    // Revoke the key; the very next request must be rejected.
    keys.set('valid-key', { id: 'key-1', status: 'revoked' });

    await request(app.getHttpServer())
      .post('/users/find-or-create')
      .set('x-api-key', 'valid-key')
      .send({ email: 'a@example.com' })
      .expect(401);

    expect(findOrCreate).toHaveBeenCalledTimes(1);
  });
});
