import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookDlqAlertService } from './webhook-dlq-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { DeliveryStatus } from './domain/webhook-events';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function buildMocks(configOverrides: Record<string, any> = {}) {
  const mockPrisma = {
    webhookDelivery: {
      count: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const mockMetrics = {
    incrementCounter: jest.fn(),
    recordHistogram: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((key: string, defaultValue: any) => {
      const config: Record<string, any> = {
        DLQ_CHECK_INTERVAL_MS: 999_999,
        DLQ_ABSOLUTE_THRESHOLD: 10,
        DLQ_PERCENTAGE_THRESHOLD: 5,
        DLQ_AGE_THRESHOLD_MS: 3_600_000,
        DLQ_OPS_WEBHOOK_URL: '',
        DLQ_OPS_WEBHOOK_TIMEOUT_MS: 5_000,
        ...configOverrides,
      };
      return config[key] ?? defaultValue;
    }),
  };

  return { mockPrisma, mockMetrics, mockConfig };
}

async function buildService(
  mocks: ReturnType<typeof buildMocks>,
): Promise<WebhookDlqAlertService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      WebhookDlqAlertService,
      { provide: PrismaService, useValue: mocks.mockPrisma },
      { provide: MetricsService, useValue: mocks.mockMetrics },
      { provide: ConfigService, useValue: mocks.mockConfig },
    ],
  }).compile();
  return module.get<WebhookDlqAlertService>(WebhookDlqAlertService);
}

// ---------------------------------------------------------------------------
// Ops webhook — disabled (no URL configured)
// ---------------------------------------------------------------------------

describe('WebhookDlqAlertService — ops webhook disabled', () => {
  let service: WebhookDlqAlertService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mocks = buildMocks({ DLQ_OPS_WEBHOOK_URL: '' });
    service = await buildService(mocks);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hasOpsWebhook() should return false when DLQ_OPS_WEBHOOK_URL is unset', () => {
    expect(service.hasOpsWebhook()).toBe(false);
  });

  it('should NOT call axios when thresholds are breached but no URL is configured', async () => {
    // DLQ depth above absolute threshold (10)
    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(20) // dlqCount
      .mockResolvedValueOnce(50); // totalCount

    await service.checkDlqDepth();

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ops webhook — enabled (URL configured)
// ---------------------------------------------------------------------------

describe('WebhookDlqAlertService — ops webhook enabled', () => {
  const OPS_URL = 'https://hooks.slack.com/services/test/webhook';
  let service: WebhookDlqAlertService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mocks = buildMocks({ DLQ_OPS_WEBHOOK_URL: OPS_URL });
    service = await buildService(mocks);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hasOpsWebhook() should return true when DLQ_OPS_WEBHOOK_URL is set', () => {
    expect(service.hasOpsWebhook()).toBe(true);
  });

  it('should POST to the ops URL when absolute threshold is breached', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });

    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(15) // dlqCount (> threshold of 10)
      .mockResolvedValueOnce(50); // totalCount

    await service.checkDlqDepth();

    expect(mockedAxios.post).toHaveBeenCalledWith(
      OPS_URL,
      expect.objectContaining({
        service: 'mux-backend',
        event: 'dlq.threshold_breached',
        dlqDepth: 15,
        alerts: expect.arrayContaining([
          expect.objectContaining({ type: 'ABSOLUTE_THRESHOLD' }),
        ]),
      }),
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
        timeout: 5_000,
      }),
    );
  });

  it('should POST to the ops URL when percentage threshold is breached', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });

    // 6 / 100 = 6%, > threshold of 5%
    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(6)  // dlqCount (below absolute threshold of 10)
      .mockResolvedValueOnce(100); // totalCount

    await service.checkDlqDepth();

    expect(mockedAxios.post).toHaveBeenCalledWith(
      OPS_URL,
      expect.objectContaining({
        event: 'dlq.threshold_breached',
        alerts: expect.arrayContaining([
          expect.objectContaining({ type: 'PERCENTAGE_THRESHOLD' }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it('should POST to the ops URL when age threshold is breached', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });

    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(2)   // dlqCount (below absolute and percentage thresholds)
      .mockResolvedValueOnce(100); // totalCount
    mocks.mockPrisma.webhookDelivery.findFirst.mockResolvedValueOnce({
      lastAttemptAt: twoHoursAgo,
      createdAt: twoHoursAgo,
    });

    await service.checkDlqDepth();

    expect(mockedAxios.post).toHaveBeenCalledWith(
      OPS_URL,
      expect.objectContaining({
        alerts: expect.arrayContaining([
          expect.objectContaining({ type: 'AGE_THRESHOLD' }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it('should include a Slack-compatible `text` field in the notification payload', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });

    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(15)
      .mockResolvedValueOnce(50);

    await service.checkDlqDepth();

    const [, payload] = mockedAxios.post.mock.calls[0];
    expect(typeof (payload as any).text).toBe('string');
    expect((payload as any).text).toContain('mux-backend');
    expect((payload as any).text).toContain('DLQ');
  });

  it('should NOT call the ops webhook when no threshold is breached', async () => {
    // All values below thresholds
    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(3)   // dlqCount (< 10 absolute)
      .mockResolvedValueOnce(100); // totalCount (3% < 5% percentage threshold)

    await service.checkDlqDepth();

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('should NOT throw when the ops webhook call fails — non-fatal', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Slack is down'));

    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(15)
      .mockResolvedValueOnce(50);

    // checkDlqDepth() must resolve normally even when the notification fails
    await expect(service.checkDlqDepth()).resolves.toBeDefined();
  });

  it('should still return correct DlqStatus when ops notification fails', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('timeout'));

    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(15)
      .mockResolvedValueOnce(50);

    const status = await service.checkDlqDepth();

    expect(status.thresholdBreached).toBe(true);
    expect(status.dlqDepth).toBe(15);
    expect(status.alerts.length).toBeGreaterThan(0);
  });

  it('should include a checkedAt ISO timestamp in the notification payload', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });

    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(15)
      .mockResolvedValueOnce(50);

    await service.checkDlqDepth();

    const [, payload] = mockedAxios.post.mock.calls[0];
    expect(typeof (payload as any).checkedAt).toBe('string');
    // Must be a parseable ISO date
    expect(() => new Date((payload as any).checkedAt)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Threshold evaluation — unchanged from original service behaviour
// ---------------------------------------------------------------------------

describe('WebhookDlqAlertService — threshold evaluation (no ops webhook)', () => {
  let service: WebhookDlqAlertService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return thresholdBreached=false when DLQ depth is below all thresholds', async () => {
    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(100);

    const status = await service.checkDlqDepth();

    expect(status.thresholdBreached).toBe(false);
    expect(status.alerts).toHaveLength(0);
  });

  it('should return thresholdBreached=true with ABSOLUTE_THRESHOLD alert', async () => {
    mocks.mockPrisma.webhookDelivery.count
      .mockResolvedValueOnce(10)  // equal to threshold
      .mockResolvedValueOnce(100);

    const status = await service.checkDlqDepth();

    expect(status.thresholdBreached).toBe(true);
    expect(status.alerts.some((a) => a.type === 'ABSOLUTE_THRESHOLD')).toBe(
      true,
    );
  });

  it('getThresholds() should return configured thresholds', () => {
    const t = service.getThresholds();
    expect(t.absoluteThreshold).toBe(10);
    expect(t.percentageThreshold).toBe(5);
    expect(t.ageThresholdMs).toBe(3_600_000);
  });
});
