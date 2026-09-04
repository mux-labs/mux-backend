import { Test, TestingModule } from '@nestjs/testing';
import { WebhookRetryService } from './webhook-retry.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ConfigService } from '@nestjs/config';

describe('WebhookRetryService', () => {
  let service: WebhookRetryService;
  let mockPrisma: any;
  let mockMetrics: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockPrisma = {
      webhookEndpoint: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      webhookDelivery: {
        update: jest.fn(),
      },
    };

    mockMetrics = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn((key: string, defaultValue: any) => defaultValue),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookRetryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<WebhookRetryService>(WebhookRetryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateNextRetry', () => {
    it('should calculate exponential backoff', () => {
      const retry1 = service.calculateNextRetry(1);
      const retry2 = service.calculateNextRetry(2);
      const retry3 = service.calculateNextRetry(3);

      // Each retry should be further in the future
      expect(retry2.getTime()).toBeGreaterThan(retry1.getTime());
      expect(retry3.getTime()).toBeGreaterThan(retry2.getTime());
    });

    it('should handle attempt 0', () => {
      const nextRetry = service.calculateNextRetry(0);
      expect(nextRetry.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('markRetrying', () => {
    it('should update delivery status to RETRYING', async () => {
      await service.markRetrying(
        'delivery-1',
        1,
        new Date(Date.now() + 1000),
        500,
        'error body',
        100,
        'error message',
        'wallet.created',
      );

      expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'delivery-1' },
        data: expect.objectContaining({
          status: 'RETRYING',
          attempts: 1,
        }),
      });

      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'webhooks_retry_total',
        { event_type: 'wallet.created' },
      );
    });
  });

  describe('handleDeliveryFailure', () => {
    it('should update delivery and track failure metrics', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue({
        id: 'endpoint-1',
        consecutiveFailures: 0,
        status: 'ACTIVE',
      });

      await service.handleDeliveryFailure(
        'delivery-1',
        'endpoint-1',
        1,
        500,
        'error body',
        100,
        'error message',
        'wallet.created',
      );

      expect(mockPrisma.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'delivery-1' },
        data: expect.objectContaining({
          status: 'FAILED',
        }),
      });

      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'webhooks_delivered_total',
        { event_type: 'wallet.created', result: 'failure' },
      );
    });

    it('should increment dead letter counter when max retries reached', async () => {
      mockPrisma.webhookEndpoint.findUnique.mockResolvedValue({
        id: 'endpoint-1',
        consecutiveFailures: 4,
        status: 'ACTIVE',
      });

      await service.handleDeliveryFailure(
        'delivery-1',
        'endpoint-1',
        5, // 5 attempts = max retries exhausted
        500,
        'error body',
        100,
        'error message',
        'wallet.created',
      );

      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'webhooks_dead_letter_total',
        { event_type: 'wallet.created' },
      );
    });
  });

  describe('markEndpointSuccess', () => {
    it('should reset consecutive failures on success', async () => {
      await service.markEndpointSuccess('endpoint-1');

      expect(mockPrisma.webhookEndpoint.update).toHaveBeenCalledWith({
        where: { id: 'endpoint-1' },
        data: expect.objectContaining({
          consecutiveFailures: 0,
          lastSuccessAt: expect.any(Date),
        }),
      });
    });
  });

  describe('getMaxRetries', () => {
    it('should return max retries configuration', () => {
      const maxRetries = service.getMaxRetries();
      expect(maxRetries).toBe(5); // Default value
    });
  });
});
