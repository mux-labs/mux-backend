import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { PrismaService } from '../prisma/prisma.service';
import { EndpointStatus } from './domain/webhook-events';
import { WebhookCacheService } from './webhook-cache.service';

const PROJECT_ID = 'project-1';
const ENDPOINT_ID = 'endpoint-1';

const mockEndpoint = {
  id: ENDPOINT_ID,
  projectId: PROJECT_ID,
  url: 'https://example.com/hook',
  description: 'Test hook',
  secret: 'whsec_abc123',
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
  let cache: WebhookCacheService;

  const mockPrisma = {
    webhookEndpoint: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    webhookDelivery: {
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        WebhookCacheService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
    cache = module.get<WebhookCacheService>(WebhookCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ─── createEndpoint ──────────────────────────────────────────────────────────

  describe('createEndpoint', () => {
    it('creates an endpoint with a generated secret', async () => {
      mockPrisma.webhookEndpoint.create.mockResolvedValue(mockEndpoint);

      const result = await service.createEndpoint({
        projectId: PROJECT_ID,
        url: 'https://example.com/hook',
        events: ['wallet.created'],
      });

      expect(result.id).toBe(ENDPOINT_ID);
      expect(result.status).toBe(EndpointStatus.ACTIVE);
      expect(mockPrisma.webhookEndpoint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId: PROJECT_ID,
            url: 'https://example.com/hook',
            status: EndpointStatus.ACTIVE,
          }),
        }),
      );
    });

    it('stores a secret matching whsec_ format', async () => {
      let capturedData: any;
      mockPrisma.webhookEndpoint.create.mockImplementation(({ data }) => {
        capturedData = data;
        return Promise.resolve({ ...mockEndpoint, secret: data.secret });
      });

      await service.createEndpoint({
        projectId: PROJECT_ID,
        url: 'https://example.com/hook',
        events: [],
      });

      expect(capturedData.secret).toMatch(/^whsec_/);
    });
  });

  // ─── listEndpoints ───────────────────────────────────────────────────────────

  describe('listEndpoints', () => {
    it('returns endpoints for a project', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([mockEndpoint]);

      const result = await service.listEndpoints(PROJECT_ID);

      expect(result).toHaveLength(1);
      expect(result[0].projectId).toBe(PROJECT_ID);
    });

    it('returns empty array when no endpoints exist', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([]);

      const result = await service.listEndpoints(PROJECT_ID);

      expect(result).toEqual([]);
    });
  });

  // ─── getEndpoint ─────────────────────────────────────────────────────────────

  describe('getEndpoint', () => {
    it('returns the endpoint when found', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);

      const result = await service.getEndpoint(ENDPOINT_ID);

      expect(result.id).toBe(ENDPOINT_ID);
    });

    it('throws NotFoundException when endpoint not found', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(null);

      await expect(service.getEndpoint(ENDPOINT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns cached endpoint on second call without hitting DB', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);

      await service.getEndpoint(ENDPOINT_ID);
      await service.getEndpoint(ENDPOINT_ID);

      expect(mockPrisma.webhookEndpoint.findUnique).toHaveBeenCalledTimes(1);
    });

    it('falls through to DB on cache miss', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);

      const result = await service.getEndpoint(ENDPOINT_ID);

      expect(result.id).toBe(ENDPOINT_ID);
      expect(mockPrisma.webhookEndpoint.findUnique).toHaveBeenCalledTimes(1);
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

    it('invalidates cache after update', async () => {
      const updated = { ...mockEndpoint, url: 'https://new.example.com/hook' };
      mockPrisma.webhookEndpoint.update.mockResolvedValue(updated);
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(updated);
      const invalidateSpy = jest.spyOn(cache, 'invalidate');

      await service.getEndpoint(ENDPOINT_ID);
      await service.updateEndpoint(ENDPOINT_ID, {
        url: 'https://new.example.com/hook',
      });
      await service.getEndpoint(ENDPOINT_ID);

      expect(invalidateSpy).toHaveBeenCalledWith(
        cache.endpointKey(ENDPOINT_ID),
      );
      expect(mockPrisma.webhookEndpoint.findUnique).toHaveBeenCalledTimes(2);
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
    it('generates a new whsec_ secret and updates the endpoint', async () => {
      let capturedData: any;
      mockPrisma.webhookEndpoint.update.mockImplementation(({ data }) => {
        capturedData = data;
        return Promise.resolve({ ...mockEndpoint, secret: data.secret });
      });

      const result = await service.rotateSecret(ENDPOINT_ID);

      expect(result.secret).toMatch(/^whsec_/);
      expect(capturedData.secret).toBe(result.secret);
    });
  });

  // ─── getDeliveries ────────────────────────────────────────────────────────────

  describe('getDeliveries', () => {
    it('returns deliveries for an endpoint with default limit', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([]);

      await service.getDeliveries(ENDPOINT_ID);

      expect(mockPrisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });

    it('respects custom limit', async () => {
      mockPrisma.webhookDelivery.findMany.mockResolvedValue([]);

      await service.getDeliveries(ENDPOINT_ID, 10);

      expect(mockPrisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });
  });
});
