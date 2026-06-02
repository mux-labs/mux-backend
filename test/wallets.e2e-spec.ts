import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { WalletsModule } from '../src/wallets/wallets.module';
import { WalletsService } from '../src/wallets/wallets.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { Reflector } from '@nestjs/core';

describe('Wallets Protected Endpoint (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mockWalletsService: Partial<WalletsService> = {
      findAll: jest.fn(async () => []),
    };

    const mockApiKeyService: Partial<ApiKeyService> = {
      validateApiKey: jest.fn(async (key: string) => ({
        apiKey: { id: 'api-key-id' },
        project: { id: 'proj-id', name: 'proj-name' },
        developer: { id: 'dev-id', email: 'dev@example.com' },
      })),
      recordUsage: jest.fn(async () => {}),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [WalletsModule],
    })
      .overrideProvider(WalletsService)
      .useValue(mockWalletsService)
      .overrideProvider(ApiKeyService)
      .useValue(mockApiKeyService)
      .compile();

    app = moduleRef.createNestApplication();

    // Apply guard globally so MVC routes are protected
    const reflector = app.get(Reflector);
    app.useGlobalGuards(
      new ApiKeyGuard(mockApiKeyService as ApiKeyService, reflector),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/v1/wallets/protected (GET) with valid ApiKey returns 200 and context', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/wallets/protected')
      .set('Authorization', 'ApiKey mux_test_abc')
      .expect(200);

    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('developer');
    expect(res.body).toHaveProperty('project');
  });
});
