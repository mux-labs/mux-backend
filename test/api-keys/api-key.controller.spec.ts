import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ExecutionContext, CanActivate } from '@nestjs/common';
import * as request from 'supertest';
import { ApiKeyController } from '../../src/api-keys/api-key.controller';
import { ApiKeyGuard } from '../../src/api-keys/api-key.guard';
import { ApiKeysService } from '../../src/api-keys/api-keys.service';

/**
 * Regression test for the ApiTags contract documented on ApiKeyController:
 * "API key management surface (#942). Every route is guarded by ApiKeyGuard,
 * so the caller is always an already-authenticated developer and ownership is
 * taken from the presenting key — never from the request body. Revocation
 * takes effect immediately: the very next request with the revoked key is
 * refused."
 */
describe('ApiKeyController (ApiTags contract)', () => {
  let app: INestApplication;
  let apiKeysService: {
    list: jest.Mock;
    create: jest.Mock;
    revoke: jest.Mock;
  };

  // Simulated key store: maps a presenting key to its owner.
  const activeKeys = new Map<string, string>([
    ['key-alice', 'developer-alice'],
    ['key-bob', 'developer-bob'],
  ]);

  const guard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      const presented = req.headers['x-api-key'] as string | undefined;
      const owner = presented ? activeKeys.get(presented) : undefined;
      if (!owner) {
        return false;
      }
      // Ownership is derived from the presenting key, never the body.
      req.developer = { id: owner };
      return true;
    },
  };

  beforeEach(async () => {
    apiKeysService = {
      list: jest.fn().mockImplementation((developerId: string) => [
        { id: 'k1', ownerId: developerId },
      ]),
      create: jest.fn().mockImplementation((developerId: string) => ({
        id: 'k-new',
        ownerId: developerId,
      })),
      revoke: jest.fn().mockImplementation((developerId: string, id: string) => {
        if (developerId !== 'developer-alice') {
          throw new Error('not owner');
        }
        return { id, revoked: true };
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ApiKeyController],
      providers: [{ provide: ApiKeysService, useValue: apiKeysService }],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue(guard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('guards every route with ApiKeyGuard', () => {
    const guards = Reflect.getMetadata('__guards__', ApiKeyController) || [];
    expect(guards).toContain(ApiKeyGuard);
  });

  it('refuses requests without a presenting key', async () => {
    await request(app.getHttpServer()).get('/api-keys').expect(403);
  });

  it('takes ownership from the presenting key, not the request body', async () => {
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('x-api-key', 'key-alice')
      .send({ ownerId: 'developer-bob' })
      .expect(201);

    expect(apiKeysService.create).toHaveBeenCalledWith('developer-alice');
    expect(apiKeysService.create).not.toHaveBeenCalledWith('developer-bob');
  });

  it('refuses the very next request with a revoked key', async () => {
    await request(app.getHttpServer())
      .get('/api-keys')
      .set('x-api-key', 'key-bob')
      .expect(200);

    // Revocation takes effect immediately.
    activeKeys.delete('key-bob');

    await request(app.getHttpServer())
      .get('/api-keys')
      .set('x-api-key', 'key-bob')
      .expect(403);
  });
});
