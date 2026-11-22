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

    it('should store the webhook secret hashed at rest, never in plaintext', async () => {
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
      // The persisted record must never contain the raw secret material.
      expect(JSON.stringify(row)).not.toContain(returnedSecret);
    });

    it('should return the plaintext secret exactly once, on create, and never on subsequent reads', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const endpointId = createRes.body.id;
      const returnedSecret = createRes.body.secret as string;
      expect(typeof returnedSecret).toBe('string');
      expect(returnedSecret.length).toBeGreaterThan(0);

      // Absent from the list response.
      const listRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}`)
        .expect(200);

      const listed = listRes.body.endpoints.find(
        (e: any) => e.id === endpointId,
      );
      expect(listed).toBeDefined();
      expect(listed).not.toHaveProperty('secret');
      expect(JSON.stringify(listRes.body)).not.toContain(returnedSecret);

      // Absent from the get-by-id response.
      const getRes = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/${endpointId}`)
        .expect(200);

      expect(getRes.body).not.toHaveProperty('secret');
      expect(JSON.stringify(getRes.body)).not.toContain(returnedSecret);

      // Absent from any subsequent create response for the same project.
      const secondCreateRes = await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      expect(secondCreateRes.body.secret).not.toBe(returnedSecret);
      expect(JSON.stringify(secondCreateRes.body)).not.toContain(
        returnedSecret,
      );
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

  describe('GET /webhooks/endpoints/project/:projectId', () => {
    it('should list endpoints for a project without exposing secrets', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/endpoints')
        .send({
          projectId: PROJECT_ID,
          url: WEBHOOK_URL,
          events: ['wallet.created'],
        })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/webhooks/endpoints/project/${PROJECT_ID}`)
        .expect(200);

      expect(Array.isArray(res.body.endpoints)).toBe(true);
      expect(res.body.endpoints.length).toBeGreaterThan(0);
      for (const endpoint of res.body.endpoints) {
        expect(endpoint).not.toHaveProperty('secret');
        expect(endpoint).not.toHaveProperty('secretHash');
      }
    });
  });

  describe('Webhook delivery signing', () => {
    it('should deliver a signed webhook payload that verifies with the endpoint secret', async () => {
      const payload = {
        event: 'wallet.created',
        data: { walletId: 'wallet-1', projectId: PROJECT_ID },
      };

      const signature = webhookSigner.sign(payload, WEBHOOK_SECRET);
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(0);

      // A correctly signed payload verifies against the same secret.
      expect(webhookSigner.verify(payload, signature, WEBHOOK_SECRET)).toBe(
        true,
      );

      (axios.post as jest.Mock).mockResolvedValueOnce({ status: 200 });

      await webhookEmitter.emit('wallet.created', payload.data, {
        projectId: PROJECT_ID,
        url: WEBHOOK_URL,
        secret: WEBHOOK_SECRET,
      });

      expect(axios.post).toHaveBeenCalled();
      const [calledUrl, calledBody, calledConfig] = (axios.post as jest.Mock)
        .mock.calls[0];
      expect(calledUrl).toBe(WEBHOOK_URL);
      expect(calledBody).toEqual(payload);
      expect(calledConfig?.headers).toBeDefined();
      const sentSignature =
        calledConfig.headers['X-Webhook-Signature'] ??
        calledConfig.headers['x-webhook-signature'];
      expect(sentSignature).toBeDefined();
      expect(
        webhookSigner.verify(payload, sentSignature, WEBHOOK_SECRET),
      ).toBe(true);
    });

    it('should reject a payload with a bad signature', async () => {
      const payload = {
        event: 'wallet.created',
        data: { walletId: 'wallet-1', projectId: PROJECT_ID },
      };

      const validSignature = webhookSigner.sign(payload, WEBHOOK_SECRET);
      const badSignature = webhookSigner.sign(payload, 'whsec_wrong_secret');

      expect(badSignature).not.toBe(validSignature);
      expect(webhookSigner.verify(payload, badSignature, WEBHOOK_SECRET)).toBe(
        false,
      );
      expect(
        webhookSigner.verify(payload, 'not-a-valid-signature', WEBHOOK_SECRET),
      ).toBe(false);
    });
  });
});
