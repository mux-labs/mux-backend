import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import requestLogger from '../common/middleware/request-logging.middleware';

describe('Webhook request ID propagation', () => {
  let app: INestApplication;

  const mockWebhookService = {
    getEndpoint: jest.fn().mockResolvedValue({
      id: 'endpoint-1',
      url: 'https://example.com/hook',
      events: ['wallet.created'],
      description: null,
      status: 'ACTIVE',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: mockWebhookService },
        {
          provide: WebhookDispatcherService,
          useValue: { processDeliveries: jest.fn() },
        },
        {
          provide: FeatureFlagService,
          useValue: { isEnabled: jest.fn().mockReturnValue(true) },
        },
      ],
    })
      .overrideGuard(FeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    app.use(requestLogger as any);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the same x-request-id on the response when provided on the request', async () => {
    const incomingId = 'client-provided-request-id';

    const response = await request(app.getHttpServer())
      .get('/webhooks/endpoints/endpoint-1')
      .set('x-request-id', incomingId)
      .expect(200);

    expect(response.headers['x-request-id']).toBe(incomingId);
  });

  it('generates and returns a UUID x-request-id when the header is absent', async () => {
    const response = await request(app.getHttpServer())
      .get('/webhooks/endpoints/endpoint-1')
      .expect(200);

    const responseId = response.headers['x-request-id'];
    expect(responseId).toBeDefined();
    expect(typeof responseId).toBe('string');
    expect(responseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
