import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { PrismaService } from '../prisma/prisma.service';
import { EndpointStatus } from './domain/webhook-events';

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

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
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
    it('returns paginated endpoints for a project', async () => {
      mockPrisma.webhookEndpoint.findMany.mockResolvedValue([mockEndpoint]);
      mockPrisma.webhookEndpoint.count.mockResolvedValue(1);

      const result = await service.listEndpoints(PROJECT_ID);

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0].projectId).toBe(PROJECT_ID);
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
