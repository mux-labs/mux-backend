/**
 * Unit tests for webhook event type subscription management (#551).
 *
 * Covers:
 *  - getSubscribedEvents: returns events from a valid endpoint
 *  - getSubscribedEvents: propagates NotFoundException for unknown endpoint
 *  - updateSubscribedEvents: replaces events with validated list
 *  - updateSubscribedEvents: rejects unknown event types with 400
 *  - updateSubscribedEvents: propagates NotFoundException for unknown endpoint
 */
import {
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookEventType, EndpointStatus } from './domain/webhook-events';

const ENDPOINT_ID = 'ep-uuid-1';
const PROJECT_ID = 'proj-uuid-1';

function makeEndpoint(override: Partial<any> = {}) {
  return {
    id: ENDPOINT_ID,
    projectId: PROJECT_ID,
    url: 'https://example.com/hook',
    description: null,
    secret: 'whsec_abc',
    events: [WebhookEventType.WALLET_CREATED],
    status: EndpointStatus.ACTIVE,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    lastSuccessAt: null,
    deletedAt: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
    ...override,
  };
}

describe('WebhookService – event subscriptions (#551)', () => {
  let service: WebhookService;

  const mockPrisma: any = {
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
    $disconnect: jest.fn(),
  };

  const mockCache: any = {
    get: jest.fn().mockReturnValue(null),
    set: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-set default implementations after clearAllMocks wipes them
    mockCache.get.mockReturnValue(null);
    // Directly instantiate to avoid NestJS DI token resolution issues
    service = new WebhookService(mockPrisma, mockCache);
  });

  // ── getSubscribedEvents ──────────────────────────────────────────────────────

  describe('getSubscribedEvents', () => {
    it('returns the events array for a known endpoint', async () => {
      const endpoint = makeEndpoint({
        events: [
          WebhookEventType.WALLET_CREATED,
          WebhookEventType.TRANSACTION_CONFIRMED,
        ],
      });
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(endpoint);

      const result = await service.getSubscribedEvents(ENDPOINT_ID);

      expect(result).toEqual([
        WebhookEventType.WALLET_CREATED,
        WebhookEventType.TRANSACTION_CONFIRMED,
      ]);
    });

    it('throws NotFoundException when endpoint does not exist', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(null);

      await expect(
        service.getSubscribedEvents('nonexistent-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateSubscribedEvents ───────────────────────────────────────────────────

  describe('updateSubscribedEvents', () => {
    it('updates and returns the new events list for valid event types', async () => {
      const newEvents = [
        WebhookEventType.WALLET_CREATED,
        WebhookEventType.BALANCE_LOW,
      ];
      const updatedEndpoint = makeEndpoint({ events: newEvents });

      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(makeEndpoint());
      mockPrisma.webhookEndpoint.update.mockResolvedValue(updatedEndpoint);

      const result = await service.updateSubscribedEvents(ENDPOINT_ID, newEvents);

      expect(result).toEqual(newEvents);
      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ENDPOINT_ID },
          data: { events: newEvents },
        }),
      );
    });

    it('invalidates the cache entry after updating events', async () => {
      const newEvents = [WebhookEventType.USER_CREATED];
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(makeEndpoint());
      mockPrisma.webhookEndpoint.update.mockResolvedValue(
        makeEndpoint({ events: newEvents }),
      );

      await service.updateSubscribedEvents(ENDPOINT_ID, newEvents);

      expect(mockCache.delete).toHaveBeenCalledWith(
        expect.stringContaining(ENDPOINT_ID),
      );
    });

    it('rejects unknown event types with BadRequestException', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(makeEndpoint());

      await expect(
        service.updateSubscribedEvents(ENDPOINT_ID, [
          WebhookEventType.WALLET_CREATED,
          'foo.unknown_event' as any,
        ]),
      ).rejects.toThrow(BadRequestException);

      // Prisma update should NOT be called
      expect(mockPrisma.webhookEndpoint.update).not.toHaveBeenCalled();
    });

    it('error message includes the invalid event type name', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(makeEndpoint());

      let threw = false;
      try {
        await service.updateSubscribedEvents(ENDPOINT_ID, [
          'invalid.event.type' as any,
        ]);
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('invalid.event.type');
      }
      expect(threw).toBe(true);
    });

    it('throws NotFoundException when endpoint does not exist', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(null);

      await expect(
        service.updateSubscribedEvents('nonexistent-id', [
          WebhookEventType.WALLET_CREATED,
        ]),
      ).rejects.toThrow(NotFoundException);
    });

    it('accepts all valid WebhookEventType values', async () => {
      const allEvents = Object.values(WebhookEventType);
      const updatedEndpoint = makeEndpoint({ events: allEvents });

      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(makeEndpoint());
      mockPrisma.webhookEndpoint.update.mockResolvedValue(updatedEndpoint);

      const result = await service.updateSubscribedEvents(ENDPOINT_ID, allEvents);
      expect(result).toEqual(allEvents);
    });
  });
});
