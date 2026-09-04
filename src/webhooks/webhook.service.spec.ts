import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { WebhookSecretService } from './webhook-secret.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache/cache.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { EndpointStatus } from './domain/webhook-events';
import * as crypto from 'crypto';

const PROJECT_ID = 'project-1';
const ENDPOINT_ID = 'endpoint-1';

const TEST_SIGNING_KEY = 'unit-test-webhook-signing-key-min-32-chars!!';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const mockEndpoint = {
  id: ENDPOINT_ID,
  projectId: PROJECT_ID,
  url: 'https://example.com/hook',
  description: 'Test hook',
  secretHash: sha256Hex('whsec_some-derived-secret'),
  secretVersion: 1,
  pendingSecretVersion: null,
  pendingSecretHash: null,
  secretGracePeriodEndsAt: null,
  events: ['wallet.created'],
  status: EndpointStatus.ACTIVE,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastFailureReason: null,
  lastSuccessAt: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('WebhookService', () => {
  let service: WebhookService;
  let secretService: WebhookSecretService;
  let cache: CacheService;

  const mockPrisma = {
    webhookEndpoint: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    webhookDelivery: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockCache = {
    get: jest.fn().mockReturnValue(null),
    set: jest.fn(),
    delete: jest.fn(),
  };

  const mockMetrics = {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCache.get.mockReturnValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        WebhookSecretService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CacheService, useValue: mockCache },
        { provide: MetricsService, useValue: mockMetrics },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue: any) => {
              if (key === 'WEBHOOK_SIGNING_KEY') return TEST_SIGNING_KEY;
              if (key === 'WEBHOOK_SECRET_GRACE_SECONDS') return 3600;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
    secretService = module.get<WebhookSecretService>(WebhookSecretService);
    cache = module.get<CacheService>(CacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── createEndpoint ──────────────────────────────────────────────────────────

  describe('createEndpoint', () => {
    it('creates an endpoint and returns the one-time plaintext secret', async () => {
      mockPrisma.webhookEndpoint.create.mockImplementation(({ data }) =>
        Promise.resolve({ ...mockEndpoint, ...data }),
      );

      const result = await service.createEndpoint({
        projectId: PROJECT_ID,
        url: 'https://example.com/hook',
        events: ['wallet.created'],
      });

      expect(result.id).toBeDefined();
      expect(result.status).toBe(EndpointStatus.ACTIVE);
      expect(result.secret).toMatch(/^whsec_/);
    });

    it('persists only a SHA-256 hash of the secret, never the plaintext', async () => {
      let capturedData: any;
      mockPrisma.webhookEndpoint.create.mockImplementation(({ data }) => {
        capturedData = data;
        return Promise.resolve({ ...mockEndpoint, ...data });
      });

      const result = await service.createEndpoint({
        projectId: PROJECT_ID,
        url: 'https://example.com/hook',
        events: ['wallet.created'],
      });

      // The plaintext secret must NEVER be persisted to the database.
      expect(capturedData.secret).toBeUndefined();
      expect(capturedData.secretHash).toBeDefined();
      // The persisted value is a SHA-256 hex digest, not the whsec_ secret.
      expect(capturedData.secretHash).toMatch(/^[a-f0-9]{64}$/);
      expect(capturedData.secretHash).not.toContain('whsec_');
      // The stored hash equals sha256 of the one-time returned secret.
      expect(capturedData.secretHash).toBe(sha256Hex(result.secret));
      // The endpoint id is generated up front so the secret is derivable.
      expect(capturedData.id).toBe(result.id);
      expect(capturedData.secretVersion).toBe(1);
    });

    it('derives a deterministic secret for a fixed endpoint id + version', async () => {
      const a = secretService.deriveSecret(ENDPOINT_ID, 1);
      const b = secretService.deriveSecret(ENDPOINT_ID, 1);
      const c = secretService.deriveSecret(ENDPOINT_ID, 2);

      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });
  });

  // ─── listEndpoints ───────────────────────────────────────────────────────────

  describe('listEndpoints', () => {
    it('returns paginated endpoints for a project', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([mockEndpoint]);
      mockPrisma.webhookEndpoint.count.mockResolvedValue(1);

      const result = await service.listEndpoints(PROJECT_ID);

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].projectId).toBe(PROJECT_ID);
      expect(result.endpoints[0].secret).toBeUndefined();
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('returns empty array with total 0 when no endpoints exist', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([]);
      mockPrisma.webhookEndpoint.count.mockResolvedValue(0);

      const result = await service.listEndpoints(PROJECT_ID);

      expect(result.endpoints).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('applies status filter', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([mockEndpoint]);
      mockPrisma.webhookEndpoint.count.mockResolvedValue(1);

      await service.listEndpoints(PROJECT_ID, { status: EndpointStatus.ACTIVE });

      expect(mockPrisma.webhookEndpoint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: EndpointStatus.ACTIVE }),
        }),
      );
    });

    it('applies event filter using has', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([mockEndpoint]);
      mockPrisma.webhookEndpoint.count.mockResolvedValue(1);

      await service.listEndpoints(PROJECT_ID, { event: 'wallet.created' });

      expect(mockPrisma.webhookEndpoint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            events: { has: 'wallet.created' },
          }),
        }),
      );
    });

    it('respects page and limit for pagination', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([]);
      mockPrisma.webhookEndpoint.count.mockResolvedValue(30);

      const result = await service.listEndpoints(PROJECT_ID, { page: 2, limit: 10 });

      expect(mockPrisma.webhookEndpoint.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(30);
    });
  });

  // ─── getEndpoint ─────────────────────────────────────────────────────────────

  describe('getEndpoint', () => {
    it('returns the endpoint when found', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);

      const result = await service.getEndpoint(ENDPOINT_ID);

      expect(result.id).toBe(ENDPOINT_ID);
      // Secret is never exposed on GET — only its hash.
      expect(result.secret).toBeUndefined();
      expect(result.secretHash).toBeDefined();
    });

    it('hits the database each time', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);

      await service.getEndpoint(ENDPOINT_ID);
      await service.getEndpoint(ENDPOINT_ID);

      expect(mockPrisma.webhookEndpoint.findUnique).toHaveBeenCalledTimes(2);
    });

    it('throws NotFoundException when endpoint not found', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(null);

      await expect(service.getEndpoint(ENDPOINT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── updateEndpoint ──────────────────────────────────────────────────────────

  describe('updateEndpoint', () => {
    it('updates and returns the endpoint', async () => {
      const updated = { ...mockEndpoint, url: 'https://new.example.com/hook' };
      mockPrisma.webhookEndpoint.update.mockResolvedValue(updated);

      const result = await service.updateEndpoint(ENDPOINT_ID, {
        url: 'https://new.example.com/hook',
      });

      expect(result.url).toBe('https://new.example.com/hook');
    });
  });

  // ─── deleteEndpoint ──────────────────────────────────────────────────────────

  describe('deleteEndpoint', () => {
    it('calls prisma delete with the correct id', async () => {
      mockPrisma.webhookEndpoint.delete.mockResolvedValue(mockEndpoint);

      await service.deleteEndpoint(ENDPOINT_ID);

      expect(mockPrisma.webhookEndpoint.delete).toHaveBeenCalledWith({
        where: { id: ENDPOINT_ID },
      });
    });
  });

  // ─── rotateSecret ─────────────────────────────────────────────────────────────

  describe('rotateSecret', () => {
    it('stages a new pending secret version and returns it exactly once', async () => {
      let capturedData: any;
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);
      mockPrisma.webhookEndpoint.update.mockImplementation(({ data }) => {
        capturedData = data;
        return Promise.resolve({ ...mockEndpoint, ...data });
      });

      const result = await service.rotateSecret(ENDPOINT_ID);

      expect(result.secret).toMatch(/^whsec_/);
      expect(capturedData.pendingSecretVersion).toBe(2);
      // Only the hash of the pending secret is persisted.
      expect(capturedData.pendingSecretHash).toBe(sha256Hex(result.secret));
      expect(capturedData.secretHash).toBeUndefined();
      expect(capturedData.secretGracePeriodEndsAt).toBeInstanceOf(Date);
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'webhooks_secrets_rotated_total',
        { result: 'rotated' },
      );
    });

    it('throws NotFoundException for an unknown endpoint', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(null);

      await expect(service.rotateSecret(ENDPOINT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── resolveSigningSecret (grace-period rotation) ─────────────────────────────

  describe('resolveSigningSecret', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns the derived secret for the established version when no rotation is pending', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);

      const secret = await service.resolveSigningSecret(ENDPOINT_ID);

      expect(secret).toBe(secretService.deriveSecret(ENDPOINT_ID, 1));
      // No writes when there is nothing to promote or backfill.
      expect(mockPrisma.webhookEndpoint.update).not.toHaveBeenCalled();
    });

    it('keeps signing with the established secret during the grace window (no downtime)', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue({
        ...mockEndpoint,
        secretVersion: 1,
        pendingSecretVersion: 2,
        pendingSecretHash: sha256Hex(secretService.deriveSecret(ENDPOINT_ID, 2)),
        secretGracePeriodEndsAt: new Date('2026-08-31T01:00:00.000Z'), // still in the future
      });

      const secret = await service.resolveSigningSecret(ENDPOINT_ID);

      // Still the established v1 secret — the pending v2 must NOT be used yet.
      expect(secret).toBe(secretService.deriveSecret(ENDPOINT_ID, 1));
      expect(mockPrisma.webhookEndpoint.update).not.toHaveBeenCalled();
    });

    it('promotes the pending secret to active once the grace window elapses', async () => {
      let stored = {
        ...mockEndpoint,
        secretVersion: 1,
        pendingSecretVersion: 2,
        pendingSecretHash: sha256Hex(secretService.deriveSecret(ENDPOINT_ID, 2)),
        secretGracePeriodEndsAt: new Date('2026-08-31T01:00:00.000Z'),
      };
      mockPrisma.webhookEndpoint.findUnique.mockImplementation(() =>
        Promise.resolve(stored),
      );
      mockPrisma.webhookEndpoint.update.mockImplementation(({ data }) => {
        stored = { ...stored, ...data };
        return Promise.resolve(stored);
      });

      // Move past the grace window.
      jest.setSystemTime(new Date('2026-08-31T02:00:00.000Z'));

      const secret = await service.resolveSigningSecret(ENDPOINT_ID);

      expect(secret).toBe(secretService.deriveSecret(ENDPOINT_ID, 2));
      expect(stored.secretVersion).toBe(2);
      expect(stored.pendingSecretVersion).toBeNull();
      expect(stored.pendingSecretHash).toBeNull();
      expect(stored.secretGracePeriodEndsAt).toBeNull();
      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalled();
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'webhooks_secrets_promoted_total',
        {},
      );
    });

    it('lazily backfills the stored hash for rows created before hashed storage', async () => {
      const legacy = { ...mockEndpoint, secretHash: '' };
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(legacy);
      mockPrisma.webhookEndpoint.update.mockResolvedValue(legacy);

      const secret = await service.resolveSigningSecret(ENDPOINT_ID);

      expect(secret).toBe(secretService.deriveSecret(ENDPOINT_ID, 1));
      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            secretHash: sha256Hex(secret),
          }),
        }),
      );
    });
  });

  // ─── getDeliveries ────────────────────────────────────────────────────────────

  describe('getDeliveries', () => {
    it('returns paginated deliveries with default page and limit', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([]);
      mockPrisma.webhookDelivery.count.mockResolvedValue(0);

      const result = await service.getDeliveries(ENDPOINT_ID);

      expect(mockPrisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 50 }),
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
      expect(result.total).toBe(0);
    });

    it('respects custom page and limit', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([]);
      mockPrisma.webhookDelivery.count.mockResolvedValue(50);

      const result = await service.getDeliveries(ENDPOINT_ID, 3, 10);

      expect(mockPrisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result.page).toBe(3);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(50);
    });

    it('returns deliveries in the response', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);
      const delivery = {
        id: 'delivery-1',
        endpointId: ENDPOINT_ID,
        eventId: 'event-1',
        eventType: 'wallet.created',
        status: 'DELIVERED',
        attempts: 1,
        maxAttempts: 5,
        createdAt: new Date(),
      };
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([delivery]);
      mockPrisma.webhookDelivery.count.mockResolvedValue(1);

      const result = await service.getDeliveries(ENDPOINT_ID);

      expect(result.deliveries).toHaveLength(1);
      expect(result.deliveries[0].id).toBe('delivery-1');
    });
  });
});
