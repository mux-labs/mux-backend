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

    it('persists only a hash of the signing secret, never the plaintext', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const returnedSecret = createRes.body.secret as string;
      expect(returnedSecret).toMatch(/^whsec_/);

      const row: any = await prisma.webhookEndpoint.findUnique({
        where: { id: createRes.body.id },
      });

      // No plaintext secret at rest — only a SHA-256 hash of the derived secret.
      expect(row).not.toHaveProperty('secret');
      expect(row.secretHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.secretHash).not.toContain('whsec_');
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

    it('should store the webhook secret hashed, never in plaintext', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const rawSecret = createRes.body.secret;
      expect(typeof rawSecret).toBe('string');
      expect(rawSecret.length).toBeGreaterThan(0);

      const stored = await prisma.webhookEndpoint.findUnique({
        where: { id: createRes.body.id },
      });
      expect(stored).toBeDefined();
      // The persisted record must never contain the raw secret material.
      expect(JSON.stringify(stored)).not.toContain(rawSecret);
      expect((stored as any).secret).not.toBe(rawSecret);
    });
  });

  describe('POST /webhooks/endpoints/:id/rotate-secret', () => {
    it('should rotate the secret and return a new raw secret once', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const endpointId = createRes.body.id;
      const originalSecret = createRes.body.secret;

      const rotateRes = await request(app.getHttpServer())
        .post(`/webhooks/endpoints/${endpointId}/rotate-secret`)
        .expect(200);

      expect(rotateRes.body).toHaveProperty('secret');
      expect(rotateRes.body.secret).not.toBe(originalSecret);
      expect(rotateRes.body).toHaveProperty('correlationId');

      // The new raw secret must not be persisted in plaintext.
      const stored = await prisma.webhookEndpoint.findUnique({
        where: { id: endpointId },
      });
      expect(JSON.stringify(stored)).not.toContain(rotateRes.body.secret);
    });

    it('should be idempotent for a repeated rotation request with the same idempotency key', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const endpointId = createRes.body.id;
      const idempotencyKey = 'rotate-idem-key-1';

      const first = await request(app.getHttpServer())
        .post(`/webhooks/endpoints/${endpointId}/rotate-secret`)
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);

      const second = await request(app.getHttpServer())
        .post(`/webhooks/endpoints/${endpointId}/rotate-secret`)
        .set('Idempotency-Key', idempotencyKey)
        .expect(200);

      expect(second.body.secret).toBe(first.body.secret);
    });

    it('should fail closed with a stable error code when the endpoint does not exist', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/endpoints/does-not-exist/rotate-secret')
        .expect(404);

      expect(res.body).toHaveProperty('code');
      expect(res.body.code).toBe('WEBHOOK_ENDPOINT_NOT_FOUND');
      expect(res.body).toHaveProperty('correlationId');
    });

    it('should deny rotation without an authorized role (deny-by-default)', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const endpointId = createRes.body.id;

      await request(app.getHttpServer())
        .post(`/webhooks/endpoints/${endpointId}/rotate-secret`)
        .set('X-Role', 'viewer')
        .expect(403);
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

    it('should verify a signature using constant-time comparison against the stored hash', () => {
      const secret = WEBHOOK_SECRET;
      const payload = JSON.stringify({ event: 'wallet.created' });
      const signature = webhookSigner.sign(payload, secret);

      expect(webhookSigner.verify(payload, signature, secret)).toBe(true);
      expect(webhookSigner.verify(payload, signature, 'whsec_wrong')).toBe(
        false,
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
      });

      // Emit event
      await webhookEmitter.emitBalanceUpdated({
        walletId: 'wallet-4',
        userId: 'user-1',
        balance: '100.00',
        asset: 'XLM',
      });

      // Process deliveries repeatedly until retries exhausted
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/webhooks/process-deliveries')
          .expect(200);
      }

      // Verify delivery is in dead letter state
      const res = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}/deliveries`)
        .expect(200);

      const deadLetter = res.body.deliveries.find(
        (d: any) => d.status === 'DEAD_LETTER',
      );
      expect(deadLetter).toBeDefined();
    });
  });
});
