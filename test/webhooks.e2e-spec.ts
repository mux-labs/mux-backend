import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookSignerService } from '../src/webhooks/webhook-signer.service';
import { WebhookEventEmitterService } from '../src/webhooks/webhook-event-emitter.service';
import axios from 'axios';

jest.mock('axios');

describe('Webhooks (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let webhookSigner: WebhookSignerService;
  let webhookEmitter: WebhookEventEmitterService;

  const PROJECT_ID = 'test-project-1';
  const WEBHOOK_URL = 'https://example.com/webhook';
  const WEBHOOK_SECRET = 'whsec_test123';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    webhookSigner = moduleFixture.get<WebhookSignerService>(
      WebhookSignerService,
    );
    webhookEmitter = moduleFixture.get<WebhookEventEmitterService>(
      WebhookEventEmitterService,
    );
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.webhookDelivery.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
    await app.close();
  });

  describe('POST /webhooks/endpoints', () => {
    it('should register a new webhook endpoint', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created', 'wallet.activated'],
          description: 'Test webhook endpoint',
        })
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('secret');
      expect(response.body.url).toBe(WEBHOOK_URL);
      expect(response.body.status).toBe('ACTIVE');
      expect(response.body.events).toContain('wallet.created');
      expect(response.body.createdAt).toBeDefined();
    });

    it('should not return secret in list endpoints', async () => {
      // Create endpoint
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      // List endpoints
      const listRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}`)
        .expect(200);

      const endpoint = listRes.body.endpoints.find(
        (e: any) => e.id === endpointId,
      );
      expect(endpoint).toBeDefined();
      expect(endpoint).not.toHaveProperty('secret');
    });
  });

  describe('GET /webhooks/endpoints/:id/deliveries', () => {
    it('should retrieve delivery history for an endpoint', async () => {
      // Create endpoint
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      // Mock axios to simulate webhook delivery
      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Emit event
      await webhookEmitter.emitWalletCreated({
        walletId: 'wallet-1',
        userId: 'user-1',
        publicKey: 'GABC123',
        network: 'testnet',
        status: 'active',
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Get deliveries
      const res = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}/deliveries`)
        .expect(200);

      expect(res.body.deliveries).toBeDefined();
      expect(Array.isArray(res.body.deliveries)).toBe(true);
    });
  });

  describe('Webhook signature verification', () => {
    it('should dispatch webhook with correct HMAC signature header', async () => {
      // Create endpoint
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.activated'],
          description: 'Signature test',
        })
        .expect(201);

      const secret = createRes.body.secret;

      // Mock axios to capture the request
      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockImplementation((url: string, data: any, config: any) => {
        // Verify signature header exists
        expect(config.headers['X-Webhook-Signature']).toBeDefined();
        expect(config.headers['X-Webhook-Signature']).toMatch(/^t=\d+,v1=/);

        // Verify other headers
        expect(config.headers['X-Webhook-Event-Type']).toBe('wallet.activated');
        expect(config.headers['X-Webhook-Event-Id']).toBeDefined();
        expect(config.headers['Content-Type']).toBe('application/json');

        return Promise.resolve({ status: 200, data: { success: true } });
      });

      // Emit event
      await webhookEmitter.emitWalletActivated({
        walletId: 'wallet-2',
        userId: 'user-1',
        publicKey: 'GABC456',
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        WEBHOOK_URL,
        expect.any(Object),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Webhook-Signature': expect.any(String),
          }),
        }),
      );
    });
  });

  describe('Webhook retry on failure', () => {
    it('should retry webhook delivery on 500 error', async () => {
      // Create endpoint
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.suspended'],
        })
        .expect(201);

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      let callCount = 0;

      mockedAxios.post.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          // Fail first two attempts
          return Promise.reject({
            response: { status: 500 },
            message: 'Server error',
          });
        }
        // Succeed on third attempt
        return Promise.resolve({ status: 200, data: { success: true } });
      });

      // Emit event
      await webhookEmitter.emitWalletSuspended({
        walletId: 'wallet-3',
        userId: 'user-1',
        reason: 'Test suspension',
      });

      // Process should attempt delivery
      const res1 = await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // First attempt fails, should retry
      expect(res1.body.retrying).toBeGreaterThan(0);
    });
  });

  describe('Webhook dead letter on exhausted retries', () => {
    it('should move webhook to dead letter after max retries', async () => {
      // Create endpoint with limited retries
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://nonexistent.example.com/webhook',
          events: ['balance.updated'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockRejectedValue({
        response: { status: 500 },
        message: 'Server error',
        code: 'ECONNREFUSED',
      });

      // Emit event
      await webhookEmitter.emitBalanceUpdated({
        walletId: 'wallet-4',
        asset: 'XLM',
        previousBalance: '100',
        newBalance: '200',
        change: '100',
      });

      // Process deliveries multiple times to exhaust retries
      for (let i = 0; i < 6; i++) {
        await request(app.getHttpServer())
          .post('/webhooks/process-deliveries')
          .expect(200);
      }

      // Verify endpoint is disabled
      const endpointRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      expect(endpointRes.body.status).toBe('FAILED');
      expect(endpointRes.body.consecutiveFailures).toBeGreaterThan(0);
    });
  });

  describe('Webhook event type filtering', () => {
    it('should only deliver to endpoints subscribed to event type', async () => {
      // Create endpoint only subscribed to wallet.created
      const endpoint1 = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://endpoint1.example.com/webhook',
          events: ['wallet.created'],
        })
        .expect(201);

      // Create endpoint subscribed to balance events
      const endpoint2 = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://endpoint2.example.com/webhook',
          events: ['balance.updated', 'balance.low'],
        })
        .expect(201);

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Emit balance.updated event
      await webhookEmitter.emitBalanceUpdated({
        walletId: 'wallet-5',
        asset: 'XLM',
        previousBalance: '50',
        newBalance: '75',
        change: '25',
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Only endpoint2 should be called
      const callsToEndpoint1 = mockedAxios.post.mock.calls.filter(
        (call) => call[0] === 'https://endpoint1.example.com/webhook',
      );
      const callsToEndpoint2 = mockedAxios.post.mock.calls.filter(
        (call) => call[0] === 'https://endpoint2.example.com/webhook',
      );

      // Endpoint1 (wallet.created) should not receive balance.updated
      expect(callsToEndpoint1.length).toBe(0);
      // Endpoint2 (balance events) should receive balance.updated
      expect(callsToEndpoint2.length).toBeGreaterThan(0);
    });
  });
});
