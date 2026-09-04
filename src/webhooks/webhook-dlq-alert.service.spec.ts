import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  WebhookDlqAlertService,
  DlqStatus,
} from './webhook-dlq-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { DeliveryStatus } from './domain/webhook-events';

describe('WebhookDlqAlertService', () => {
  let service: WebhookDlqAlertService;
  let mockPrisma: {
    webhookDelivery: {
      count: jest.Mock;
      findFirst: jest.Mock;
    };
  };
  let mockMetrics: {
    incrementCounter: jest.Mock;
    recordHistogram: jest.Mock;
  };
  let mockConfigService: {
    get: jest.Mock;
  };

  beforeEach(async () => {
    mockPrisma = {
      webhookDelivery: {
        count: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    mockMetrics = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
    };

    // Default config: low thresholds so tests can easily trigger alerts
    mockConfigService = {
      get: jest.fn((key: string, defaultValue: any) => {
        const config: Record<string, any> = {
          DLQ_CHECK_INTERVAL_MS: 999_999, // effectively disabled in tests
          DLQ_ABSOLUTE_THRESHOLD: 10,
          DLQ_PERCENTAGE_THRESHOLD: 5,
          DLQ_AGE_THRESHOLD_MS: 3_600_000, // 1 hour
        };
        return config[key] ?? defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDlqAlertService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<WebhookDlqAlertService>(WebhookDlqAlertService);

    // Prevent real timers from running during tests
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // checkDlqDepth — success path
  // ---------------------------------------------------------------------------

  describe('checkDlqDepth', () => {
    it('should return status with no alerts when all metrics are below thresholds', async () => {
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(3)  // dlqCount
        .mockResolvedValueOnce(200); // totalCount
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce({
        lastAttemptAt: new Date(Date.now() - 60_000), // 1 minute ago — well under 1h threshold
        createdAt: new Date(Date.now() - 60_000),
      });

      const status: DlqStatus = await service.checkDlqDepth();

      expect(status.dlqDepth).toBe(3);
      expect(status.totalDeliveries).toBe(200);
      expect(status.thresholdBreached).toBe(false);
      expect(status.alerts).toHaveLength(0);
      expect(status.checkedAt).toBeInstanceOf(Date);
    });

    it('should fire ABSOLUTE_THRESHOLD alert when DLQ depth reaches threshold', async () => {
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(10)  // dlqCount — exactly at threshold
        .mockResolvedValueOnce(500); // totalCount
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce(null);

      const status = await service.checkDlqDepth();

      expect(status.thresholdBreached).toBe(true);
      const alert = status.alerts.find((a) => a.type === 'ABSOLUTE_THRESHOLD');
      expect(alert).toBeDefined();
      expect(alert!.value).toBe(10);
      expect(alert!.threshold).toBe(10);
    });

    it('should fire PERCENTAGE_THRESHOLD alert when DLQ% reaches threshold', async () => {
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(5)  // dlqCount = 5
        .mockResolvedValueOnce(100); // totalCount = 100 → 5% = exactly at threshold
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce(null);

      const status = await service.checkDlqDepth();

      expect(status.thresholdBreached).toBe(true);
      const alert = status.alerts.find((a) => a.type === 'PERCENTAGE_THRESHOLD');
      expect(alert).toBeDefined();
      expect(alert!.value).toBe(5);
    });

    it('should fire AGE_THRESHOLD alert when oldest DLQ item exceeds age threshold', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(1)   // dlqCount — below absolute threshold
        .mockResolvedValueOnce(100); // totalCount — below percentage threshold
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce({
        lastAttemptAt: twoHoursAgo,
        createdAt: twoHoursAgo,
      });

      const status = await service.checkDlqDepth();

      expect(status.thresholdBreached).toBe(true);
      const alert = status.alerts.find((a) => a.type === 'AGE_THRESHOLD');
      expect(alert).toBeDefined();
      expect(alert!.value).toBeGreaterThanOrEqual(3_600_000); // ≥ 1 hour in ms
    });

    it('should fire multiple alerts simultaneously', async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000);
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(15) // over absolute threshold (10)
        .mockResolvedValueOnce(20); // 75% DLQ rate — over percentage threshold (5%)
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce({
        lastAttemptAt: threeHoursAgo,
        createdAt: threeHoursAgo,
      });

      const status = await service.checkDlqDepth();

      expect(status.thresholdBreached).toBe(true);
      expect(status.alerts.length).toBeGreaterThanOrEqual(3);
      const types = status.alerts.map((a) => a.type);
      expect(types).toContain('ABSOLUTE_THRESHOLD');
      expect(types).toContain('PERCENTAGE_THRESHOLD');
      expect(types).toContain('AGE_THRESHOLD');
    });

    it('should handle empty delivery table gracefully (zero division)', async () => {
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(0)  // dlqCount
        .mockResolvedValueOnce(0); // totalCount
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce(null);

      const status = await service.checkDlqDepth();

      expect(status.dlqDepth).toBe(0);
      expect(status.dlqPercentage).toBe(0);
      expect(status.thresholdBreached).toBe(false);
    });

    it('should emit Prometheus metrics on every check', async () => {
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(100);
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce(null);

      await service.checkDlqDepth();

      expect(mockMetrics.recordHistogram).toHaveBeenCalledWith(
        'webhook_dlq_depth',
        2,
        {},
      );
      expect(mockMetrics.recordHistogram).toHaveBeenCalledWith(
        'webhook_dlq_percentage',
        expect.any(Number),
        {},
      );
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'webhook_dlq_checks_total',
        {},
      );
    });

    it('should emit alert_fired counter when threshold is breached', async () => {
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(20) // over absolute threshold
        .mockResolvedValueOnce(100);
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce(null);

      await service.checkDlqDepth();

      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'webhook_dlq_alert_fired_total',
        expect.objectContaining({ reason: expect.any(String) }),
      );
    });

    it('should record oldest item age metric when DLQ item exists', async () => {
      const tenMinutesAgo = new Date(Date.now() - 600_000);
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(100);
      mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce({
        lastAttemptAt: tenMinutesAgo,
        createdAt: tenMinutesAgo,
      });

      await service.checkDlqDepth();

      expect(mockMetrics.recordHistogram).toHaveBeenCalledWith(
        'webhook_dlq_oldest_item_age_seconds',
        expect.any(Number),
        {},
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getDlqDepth — lightweight read
  // ---------------------------------------------------------------------------

  describe('getDlqDepth', () => {
    it('should return depth, total, and percentage without triggering alert logic', async () => {
      mockPrisma.webhookDelivery.count
        .mockResolvedValueOnce(7)   // depth
        .mockResolvedValueOnce(70); // total

      const result = await service.getDlqDepth();

      expect(result.depth).toBe(7);
      expect(result.total).toBe(70);
      expect(result.percentage).toBeCloseTo(10, 1);
      // Should NOT have incremented alert counters
      expect(mockMetrics.incrementCounter).not.toHaveBeenCalledWith(
        'webhook_dlq_alert_fired_total',
        expect.anything(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getThresholds
  // ---------------------------------------------------------------------------

  describe('getThresholds', () => {
    it('should return a copy of the configured thresholds', () => {
      const thresholds = service.getThresholds();
      expect(thresholds.absoluteThreshold).toBe(10);
      expect(thresholds.percentageThreshold).toBe(5);
      expect(thresholds.ageThresholdMs).toBe(3_600_000);
    });

    it('should return a copy, not the internal reference', () => {
      const t1 = service.getThresholds();
      const t2 = service.getThresholds();
      expect(t1).not.toBe(t2);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('onModuleDestroy', () => {
    it('should clear the polling interval when destroyed', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      // Simulate onModuleInit to start the timer
      service.onModuleInit();
      service.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });
});
