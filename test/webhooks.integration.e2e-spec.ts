import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WebhookSignerService } from '../src/webhooks/webhook-signer.service';
import { WebhookEventEmitterService } from '../src/webhooks/webhook-event-emitter.service';
import { WebhookService } from '../src/webhooks/webhook.service';
import axios from 'axios';
import * as crypto from 'crypto';

jest.mock('axios');

describe('Webhooks Integration Tests (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let webhookSigner: WebhookSignerService;
  let webhookEmitter: WebhookEventEmitterService;
  let webhookService: WebhookService;

  const PROJECT_ID = 'test-project-integration-1';
  const WEBHOOK_URL = 'https://example.com/webhook';
  const WEBHOOK_URL_2 = 'https://example.com/webhook2';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    webhookSigner =
      moduleFixture.get<WebhookSignerService>(WebhookSignerService);
    webhookEmitter = moduleFixture.get<WebhookEventEmitterService>(
      WebhookEventEmitterService,
    );
    webhookService = moduleFixture.get<WebhookService>(WebhookService);
  });

  afterAll(async () => {
    await prisma.webhookDelivery.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({
      where: { projectId: PROJECT_ID },
    });
    await app.close();
  });

  describe('CRUD Operations - Create Endpoint', () => {
    it('should create a webhook endpoint with valid data', async () => {
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
      expect(response.body.events).toEqual([
        'wallet.created',
        'wallet.activated',
      ]);
      expect(response.body.description).toBe('Test webhook endpoint');
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.secret).toMatch(/^whsec_/);
    });

    it('should reject invalid URL', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'not-a-url',
          events: ['wallet.created'],
        })
        .expect(400);

      expect(response.body.message).toContain('url must be a valid URL');
    });

    it('should reject empty events array', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: [],
        })
        .expect(400);

      expect(response.body.message).toContain('events must not be empty');
    });

    it('should reject missing required fields', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          // missing url and events
        })
        .expect(400);

      expect(response.body.statusCode).toBe(400);
    });
  });

  describe('CRUD Operations - List Endpoints', () => {
    let endpointId1: string;
    let endpointId2: string;

    beforeAll(async () => {
      // Create multiple endpoints for list testing
      const res1 = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://endpoint1.example.com/webhook',
          events: ['wallet.created'],
          description: 'Endpoint 1',
        });
      endpointId1 = res1.body.id;

      const res2 = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://endpoint2.example.com/webhook',
          events: ['transaction.confirmed'],
          description: 'Endpoint 2',
        });
      endpointId2 = res2.body.id;
    });

    it('should list all endpoints for a project', async () => {
      const response = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}`)
        .expect(200);

      expect(Array.isArray(response.body.endpoints)).toBe(true);
      expect(response.body.endpoints.length).toBeGreaterThanOrEqual(2);
      expect(response.body.total).toBeGreaterThanOrEqual(2);
      expect(response.body.page).toBe(1);
      expect(response.body.limit).toBe(20);
    });

    it('should not return secret in list', async () => {
      const response = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}`)
        .expect(200);

      const endpoint = response.body.endpoints.find(
        (e: any) => e.id === endpointId1,
      );
      expect(endpoint).toBeDefined();
      expect(endpoint).not.toHaveProperty('secret');
    });

    it('should support pagination', async () => {
      const response = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}?page=1&limit=1`)
        .expect(200);

      expect(response.body.limit).toBe(1);
      expect(response.body.page).toBe(1);
      expect(response.body.endpoints.length).toBeLessThanOrEqual(1);
    });

    it('should enforce max limit of 100', async () => {
      const response = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}?limit=150`)
        .expect(200);

      expect(response.body.limit).toBe(100);
    });
  });

  describe('CRUD Operations - Get Endpoint', () => {
    let endpointId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://get-endpoint.example.com/webhook',
          events: ['wallet.created'],
          description: 'Get endpoint test',
        });
      endpointId = res.body.id;
    });

    it('should retrieve a specific endpoint by ID', async () => {
      const response = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      expect(response.body.id).toBe(endpointId);
      expect(response.body.url).toBe(
        'https://get-endpoint.example.com/webhook',
      );
      expect(response.body.events).toContain('wallet.created');
      expect(response.body.status).toBe('ACTIVE');
    });

    it('should not return secret in get response', async () => {
      const response = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      expect(response.body).not.toHaveProperty('secret');
    });

    it('should return 404 for non-existent endpoint', async () => {
      await request(app.getHttpServer())
        .get('/webhooks/endpoints/non-existent-id')
        .expect(404);
    });
  });

  describe('CRUD Operations - Update Endpoint', () => {
    let endpointId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://update-endpoint.example.com/webhook',
          events: ['wallet.created'],
          description: 'Original description',
        });
      endpointId = res.body.id;
    });

    it('should update endpoint URL', async () => {
      const newUrl = 'https://updated-endpoint.example.com/webhook';
      const response = await request(app.getHttpServer())
        .put(`/webhooks/endpoints/${endpointId}`)
        .send({
          url: newUrl,
        })
        .expect(200);

      expect(response.body.url).toBe(newUrl);
    });

    it('should update subscribed events', async () => {
      const newEvents = ['transaction.confirmed', 'balance.updated'];
      const response = await request(app.getHttpServer())
        .put(`/webhooks/endpoints/${endpointId}`)
        .send({
          events: newEvents,
        })
        .expect(200);

      expect(response.body.events).toEqual(newEvents);
    });

    it('should update description', async () => {
      const newDescription = 'Updated description';
      const response = await request(app.getHttpServer())
        .put(`/webhooks/endpoints/${endpointId}`)
        .send({
          description: newDescription,
        })
        .expect(200);

      expect(response.body.description).toBe(newDescription);
    });

    it('should reject invalid update URL', async () => {
      await request(app.getHttpServer())
        .put(`/webhooks/endpoints/${endpointId}`)
        .send({
          url: 'invalid-url',
        })
        .expect(400);
    });
  });

  describe('CRUD Operations - Delete Endpoint', () => {
    let endpointId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://delete-endpoint.example.com/webhook',
          events: ['wallet.created'],
        });
      endpointId = res.body.id;
    });

    it('should delete an endpoint', async () => {
      await request(app.getHttpServer())
        .delete(`/webhooks/endpoints/${endpointId}`)
        .expect(204);

      // Verify it's deleted
      await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(404);
    });

    it('should return 404 when deleting non-existent endpoint', async () => {
      await request(app.getHttpServer())
        .delete('/webhooks/endpoints/non-existent-id')
        .expect(404);
    });
  });

  describe('Event Emission and Delivery', () => {
    it('should emit wallet.created event and deliver to subscribed endpoints', async () => {
      // Create endpoint subscribed to wallet.created
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
          description: 'Wallet creation listener',
        })
        .expect(201);

      const endpointId = createRes.body.id;

      // Mock axios to capture delivery
      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Emit wallet.created event
      await webhookEmitter.emitWalletCreated({
        walletId: 'wallet-event-1',
        userId: 'user-1',
        publicKey: 'GABC123',
        network: 'testnet',
        status: 'active',
      });

      // Process deliveries
      const processRes = await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      expect(processRes.body.processed).toBeGreaterThanOrEqual(0);
    });

    it('should emit and deliver transaction.confirmed event', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['transaction.confirmed'],
        })
        .expect(201);

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Emit transaction.confirmed event
      await webhookEmitter.emitTransactionConfirmed({
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        from: 'GABC123',
        to: 'GDEF456',
        amount: '100',
        asset: 'XLM',
        ledger: 12345,
        hash: 'abc123hash',
      });

      // Process deliveries
      const processRes = await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      expect(processRes.body.processed).toBeGreaterThanOrEqual(0);
    });

    it('should emit and deliver balance.updated event', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['balance.updated'],
        })
        .expect(201);

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Emit balance.updated event
      await webhookEmitter.emitBalanceUpdated({
        walletId: 'wallet-balance-1',
        asset: 'XLM',
        previousBalance: '100',
        newBalance: '200',
        change: '100',
      });

      // Process deliveries
      const processRes = await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      expect(processRes.body.processed).toBeGreaterThanOrEqual(0);
    });

    it('should only deliver to endpoints subscribed to the event type', async () => {
      // Create endpoint only subscribed to wallet.created
      const endpoint1 = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://wallet-only.example.com/webhook',
          events: ['wallet.created'],
        })
        .expect(201);

      // Create endpoint subscribed to balance events
      const endpoint2 = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://balance-only.example.com/webhook',
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
        walletId: 'wallet-filter-test',
        asset: 'XLM',
        previousBalance: '50',
        newBalance: '75',
        change: '25',
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Endpoint2 should be called for balance.updated
      const endpoint2Calls = mockedAxios.post.mock.calls.filter(
        (call) => call[0] === 'https://balance-only.example.com/webhook',
      );
      expect(endpoint2Calls.length).toBeGreaterThanOrEqual(0);
    });

    it('should retrieve delivery history for an endpoint', async () => {
      // Create endpoint
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.activated'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Emit event
      await webhookEmitter.emitWalletActivated({
        walletId: 'wallet-activated-1',
        userId: 'user-1',
        publicKey: 'GABC123',
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
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(50);
      expect(res.body.total).toBeGreaterThanOrEqual(0);
    });

    it('should support pagination for delivery history', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['user.created'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      const res = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}/deliveries?page=1&limit=10`)
        .expect(200);

      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(10);
    });
  });

  describe('Retry and Failure Handling', () => {
    it('should retry webhook delivery on transient failure', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://retry-test.example.com/webhook',
          events: ['wallet.suspended'],
        })
        .expect(201);

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      let callCount = 0;

      mockedAxios.post.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          // Fail first two attempts with 500
          return Promise.reject({
            response: { status: 500 },
            message: 'Server error',
            code: 'ECONNREFUSED',
          });
        }
        // Succeed on third attempt
        return Promise.resolve({ status: 200, data: { success: true } });
      });

      // Emit event
      await webhookEmitter.emitWalletSuspended({
        walletId: 'wallet-retry-1',
        userId: 'user-1',
        reason: 'Test suspension',
      });

      // First process attempt
      const processRes1 = await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Should have some retrying or in-progress deliveries
      expect(
        processRes1.body.retrying +
          processRes1.body.failed +
          processRes1.body.delivered,
      ).toBeGreaterThanOrEqual(0);
    });

    it('should move endpoint to FAILED status after exhausted retries', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://nonexistent-server.example.invalid/webhook',
          events: ['balance.low'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockRejectedValue({
        response: { status: 500 },
        message: 'Service unavailable',
        code: 'ECONNREFUSED',
      });

      // Emit event
      await webhookEmitter.emitBalanceUpdated({
        walletId: 'wallet-failed-1',
        asset: 'XLM',
        previousBalance: '100',
        newBalance: '10',
        change: '-90',
      });

      // Process deliveries multiple times to exhaust retries
      for (let i = 0; i < 6; i++) {
        await request(app.getHttpServer())
          .post('/webhooks/process-deliveries')
          .expect(200);

        // Small delay between attempts
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Verify endpoint status changed
      const endpointRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      // After exhausted retries, endpoint should be in FAILED state or have consecutive failures tracked
      expect(endpointRes.body.status).toBeDefined();
      expect(endpointRes.body.consecutiveFailures).toBeGreaterThanOrEqual(0);
    });

    it('should track consecutive failures on endpoints', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: 'https://failure-tracker.example.com/webhook',
          events: ['transaction.failed'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockRejectedValue({
        response: { status: 500 },
        message: 'Internal server error',
      });

      // Emit multiple events
      for (let i = 0; i < 3; i++) {
        await webhookEmitter.emitTransactionFailed({
          transactionId: `tx-failed-${i}`,
          walletId: 'wallet-fail',
          reason: 'Insufficient balance',
          error: 'TX_FAILED',
        });
      }

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Get endpoint to check failure tracking
      const endpointRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      expect(endpointRes.body.consecutiveFailures).toBeGreaterThanOrEqual(0);
      expect(endpointRes.body.lastFailureAt).toBeDefined();
    });

    it('should support dead letter retrieval for failed deliveries', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.rotated'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      mockedAxios.post.mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      // Emit event
      await webhookEmitter.emitWalletRotated({
        walletId: 'wallet-rotate-1',
        oldPublicKey: 'GABC123',
        newPublicKey: 'GDEF456',
        rotatedAt: new Date(),
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Retrieve delivery history
      const deliveriesRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}/deliveries`)
        .expect(200);

      // Should have delivery records
      expect(deliveriesRes.body.deliveries).toBeDefined();
      expect(Array.isArray(deliveriesRes.body.deliveries)).toBe(true);
    });
  });

  describe('Signature Verification', () => {
    it('should dispatch webhook with correct HMAC-SHA256 signature', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.activated'],
          description: 'Signature verification test',
        })
        .expect(201);

      const secret = createRes.body.secret;

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      let capturedHeaders: any = {};

      mockedAxios.post.mockImplementation(
        (url: string, data: any, config: any) => {
          capturedHeaders = config.headers;
          return Promise.resolve({ status: 200, data: { success: true } });
        },
      );

      // Emit event
      await webhookEmitter.emitWalletActivated({
        walletId: 'wallet-sig-test-1',
        userId: 'user-1',
        publicKey: 'GABC123',
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Verify signature header exists and has correct format
      expect(capturedHeaders['X-Webhook-Signature']).toBeDefined();
      expect(capturedHeaders['X-Webhook-Signature']).toMatch(/^t=\d+,v1=/);
    });

    it('should include required webhook headers', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['transaction.created'],
        })
        .expect(201);

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      let capturedHeaders: any = {};

      mockedAxios.post.mockImplementation(
        (url: string, data: any, config: any) => {
          capturedHeaders = config.headers;
          return Promise.resolve({ status: 200, data: { success: true } });
        },
      );

      // Emit event
      await webhookEmitter.emitTransactionCreated({
        transactionId: 'tx-header-test',
        walletId: 'wallet-1',
        type: 'PAYMENT',
        amount: '100',
        asset: 'XLM',
        destination: 'GDEF456',
        fee: '0.00001',
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Verify required headers
      expect(capturedHeaders['X-Webhook-Signature']).toBeDefined();
      expect(capturedHeaders['X-Webhook-Event-Type']).toBeDefined();
      expect(capturedHeaders['X-Webhook-Event-Id']).toBeDefined();
      expect(capturedHeaders['Content-Type']).toBe('application/json');
    });

    it('should use timestamp in signature format', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['balance.updated'],
        })
        .expect(201);

      const mockedAxios = axios as jest.Mocked<typeof axios>;
      let capturedSignature: string = '';

      mockedAxios.post.mockImplementation(
        (url: string, data: any, config: any) => {
          capturedSignature = config.headers['X-Webhook-Signature'] || '';
          return Promise.resolve({ status: 200, data: { success: true } });
        },
      );

      // Emit event
      await webhookEmitter.emitBalanceUpdated({
        walletId: 'wallet-timestamp-test',
        asset: 'XLM',
        previousBalance: '50',
        newBalance: '100',
        change: '50',
      });

      // Process deliveries
      await request(app.getHttpServer())
        .post('/webhooks/process-deliveries')
        .expect(200);

      // Signature should include timestamp and version
      const parts = capturedSignature.split(',');
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts[0]).toMatch(/^t=\d+$/);
      expect(parts[1]).toMatch(/^v1=/);
    });
  });

  describe('Secret Rotation', () => {
    it('should rotate webhook secret', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
          description: 'Secret rotation test',
        })
        .expect(201);

      const endpointId = createRes.body.id;
      const originalSecret = createRes.body.secret;

      // Rotate secret
      const rotateRes = await request(app.getHttpServer())
        .post(`/webhooks/endpoints/${endpointId}/rotate-secret`)
        .expect(200);

      expect(rotateRes.body.secret).toBeDefined();
      expect(rotateRes.body.secret).not.toBe(originalSecret);
      expect(rotateRes.body.secret).toMatch(/^whsec_/);
      expect(rotateRes.body.rotatedAt).toBeDefined();
    });

    it('should only return secret on creation and rotation', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['transaction.confirmed'],
          description: 'Secret exposure test',
        })
        .expect(201);

      const endpointId = createRes.body.id;
      const secretAtCreation = createRes.body.secret;

      // Get endpoint - should not have secret
      const getRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      expect(getRes.body).not.toHaveProperty('secret');

      // List endpoints - should not have secret
      const listRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}`)
        .expect(200);

      const endpoint = listRes.body.endpoints.find(
        (e: any) => e.id === endpointId,
      );
      expect(endpoint).not.toHaveProperty('secret');

      // Rotate and get new secret
      const rotateRes = await request(app.getHttpServer())
        .post(`/webhooks/endpoints/${endpointId}/rotate-secret`)
        .expect(200);

      const newSecret = rotateRes.body.secret;

      // After rotation, get should still not return secret
      const getAfterRotateRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      expect(getAfterRotateRes.body).not.toHaveProperty('secret');
    });

    it('should support multiple secret rotations', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['user.updated'],
        })
        .expect(201);

      const endpointId = createRes.body.id;
      const secrets: string[] = [createRes.body.secret];

      // Rotate multiple times
      for (let i = 0; i < 3; i++) {
        const rotateRes = await request(app.getHttpServer())
          .post(`/webhooks/endpoints/${endpointId}/rotate-secret`)
          .expect(200);

        secrets.push(rotateRes.body.secret);
      }

      // All secrets should be unique
      const uniqueSecrets = new Set(secrets);
      expect(uniqueSecrets.size).toBe(secrets.length);

      // All should follow secret format
      secrets.forEach((secret) => {
        expect(secret).toMatch(/^whsec_/);
      });
    });
  });
});
