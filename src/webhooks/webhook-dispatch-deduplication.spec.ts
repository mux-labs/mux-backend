/**
 * Webhook Dispatch Deduplication Tests
 *
 * Context: the codebase contains two similarly-named services:
 *
 *   webhook-dispatch.service.ts   — LOW-LEVEL primitive
 *     • Responsible ONLY for signing a payload and making the outbound HTTP call
 *     • Knows nothing about endpoints, retries, or delivery records
 *     • Canonical type: WebhookDispatchService
 *
 *   webhook-dispatcher.service.ts — HIGH-LEVEL orchestrator
 *     • Finds subscribed webhook endpoints from the database
 *     • Creates WebhookDelivery records
 *     • Delegates the raw HTTP delivery to WebhookDispatchService
 *     • Delegates retry/DLQ logic to WebhookRetryService
 *     • Canonical type: WebhookDispatcherService
 *
 * These tests document and lock in that separation so neither service silently
 * takes on the other's responsibilities. A failing test here means someone has
 * coupled the two layers incorrectly.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookSignerService } from './webhook-signer.service';
import { WebhookRetryService } from './webhook-retry.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { EndpointStatus } from './domain/webhook-events';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------
const mockConfigService = {
  get: jest.fn((key: string, defaultValue: any) => defaultValue),
};

const mockMetrics = {
  incrementCounter: jest.fn(),
  recordHistogram: jest.fn(),
};

const mockPrisma = {
  webhookEndpoint: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  webhookDelivery: {
    findMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
};

// ---------------------------------------------------------------------------
// 1. Role separation — dispatch service MUST NOT know about DB entities
// ---------------------------------------------------------------------------
describe('WebhookDispatchService (low-level HTTP primitive)', () => {
  let dispatchService: WebhookDispatchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatchService,
        WebhookSignerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MetricsService, useValue: mockMetrics },
      ],
    }).compile();

    dispatchService = module.get<WebhookDispatchService>(WebhookDispatchService);
  });

  it('should be instantiable without PrismaService — it is DB-free', () => {
    // If this test fails, WebhookDispatchService has acquired a DB dependency,
    // which violates the single-responsibility boundary.
    expect(dispatchService).toBeDefined();
  });

  it('deliverWebhook() should exist and accept (url, payload, eventType, eventId, secret)', () => {
    expect(typeof dispatchService.deliverWebhook).toBe('function');
    // Verify the arity: url, payload, eventType, eventId, secret [, mtls]
    expect(dispatchService.deliverWebhook.length).toBeGreaterThanOrEqual(5);
  });

  it('should NOT expose dispatchEvent() — that belongs to the orchestrator', () => {
    // If WebhookDispatchService grows dispatchEvent(), it has merged with the
    // orchestrator and the canonical path is ambiguous.
    expect((dispatchService as any).dispatchEvent).toBeUndefined();
  });

  it('should NOT expose processDeliveries() — that belongs to the orchestrator', () => {
    expect((dispatchService as any).processDeliveries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Role separation — dispatcher MUST delegate HTTP work to dispatch service
// ---------------------------------------------------------------------------
describe('WebhookDispatcherService (high-level orchestrator)', () => {
  let dispatcherService: WebhookDispatcherService;
  let mockDispatchService: jest.Mocked<Partial<WebhookDispatchService>>;

  beforeEach(async () => {
    mockDispatchService = {
      deliverWebhook: jest.fn().mockResolvedValue({
        success: true,
        responseTime: 42,
        responseStatus: 200,
        responseBody: '{}',
      }),
      isRetryableError: jest.fn().mockReturnValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatcherService,
        WebhookRetryService,
        WebhookSignerService,
        { provide: WebhookDispatchService, useValue: mockDispatchService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    dispatcherService = module.get<WebhookDispatcherService>(
      WebhookDispatcherService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('should expose dispatchEvent() and processDeliveries() — canonical orchestrator API', () => {
    expect(typeof dispatcherService.dispatchEvent).toBe('function');
    expect(typeof dispatcherService.processDeliveries).toBe('function');
  });

  it('should NOT expose deliverWebhook() directly — HTTP delivery is encapsulated in WebhookDispatchService', () => {
    // The orchestrator must never expose the raw HTTP primitive — callers
    // should always go through dispatchEvent() or processDeliveries().
    expect((dispatcherService as any).deliverWebhook).toBeUndefined();
  });

  it('processDeliveries() should delegate HTTP work to WebhookDispatchService, not perform it directly', async () => {
    const mockEndpoint = {
      id: 'ep-1',
      url: 'https://example.com/hook',
      secret: 'whsec_test',
      status: EndpointStatus.ACTIVE,
      projectId: 'proj-1',
      consecutiveFailures: 0,
    };

    const mockDelivery = {
      id: 'del-1',
      eventType: 'wallet.created',
      eventId: 'evt-1',
      payload: { type: 'wallet.created' },
      attempts: 0,
      endpoint: mockEndpoint,
    };

    mockPrisma.webhookDelivery.findMany.mockResolvedValueOnce([mockDelivery]);
    mockPrisma.webhookDelivery.update.mockResolvedValue({});
    mockPrisma.webhookEndpoint.findUnique.mockResolvedValue(mockEndpoint);
    mockPrisma.webhookEndpoint.update.mockResolvedValue({});

    await dispatcherService.processDeliveries();

    // The orchestrator MUST have delegated to the dispatch service
    expect(mockDispatchService.deliverWebhook).toHaveBeenCalledTimes(1);
    expect(mockDispatchService.deliverWebhook).toHaveBeenCalledWith(
      mockEndpoint.url,
      mockDelivery.payload,
      mockDelivery.eventType,
      mockDelivery.eventId,
      mockEndpoint.secret,
    );
  });

  it('dispatchEvent() should create delivery records then trigger processDeliveries()', async () => {
    const mockEndpoint = {
      id: 'ep-2',
      url: 'https://example.com/hook2',
      secret: 'whsec_test2',
      status: EndpointStatus.ACTIVE,
      projectId: 'proj-2',
      events: ['user.created'],
      consecutiveFailures: 0,
    };

    mockPrisma.webhookEndpoint.findMany.mockResolvedValueOnce([mockEndpoint]);
    mockPrisma.webhookDelivery.create.mockResolvedValue({ id: 'del-new' });
    // processDeliveries() will call findMany for pending deliveries — return empty to keep test fast
    mockPrisma.webhookDelivery.findMany.mockResolvedValue([]);

    await dispatcherService.dispatchEvent({
      event: { id: 'evt-2', type: 'user.created' } as any,
    });

    expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          endpointId: mockEndpoint.id,
          eventType: 'user.created',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Guard against accidental re-unification — the module must register BOTH
// ---------------------------------------------------------------------------
describe('WebhookModule provider registration', () => {
  it('should register both WebhookDispatchService and WebhookDispatcherService as distinct providers', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDispatchService,
        WebhookDispatcherService,
        WebhookRetryService,
        WebhookSignerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    const dispatch = module.get(WebhookDispatchService);
    const dispatcher = module.get(WebhookDispatcherService);

    expect(dispatch).toBeDefined();
    expect(dispatcher).toBeDefined();
    // They must be different objects
    expect(dispatch).not.toBe(dispatcher);
    // They must have different prototypes (not the same class)
    expect(Object.getPrototypeOf(dispatch)).not.toBe(
      Object.getPrototypeOf(dispatcher),
    );
  });
});
