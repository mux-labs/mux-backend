import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookRetryService } from './webhook-retry.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { SafeLogger } from '../common/safe-logger';
import {
  WebhookEvent,
  DeliveryStatus,
  EndpointStatus,
} from './domain/webhook-events';
import { AxiosError } from 'axios';

export interface DispatchEventRequest {
  event: WebhookEvent;
  projectId?: string; // Optional: dispatch only to specific project
}

/**
 * Webhook Dispatcher Service
 *
 * Orchestrates webhook dispatch by coordinating between:
 * - WebhookDispatchService: handles HTTP delivery
 * - WebhookRetryService: handles retry scheduling and dead letter
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new SafeLogger(WebhookDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatchService: WebhookDispatchService,
    private readonly retryService: WebhookRetryService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }

  /**
   * Structured logging helper: routes to the matching SafeLogger level with
   * a redacted metadata payload attached.
   */
  private log(
    level: 'log' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    this.logger[level](message, meta ?? {});
  }

  /**
   * Dispatches an event to all registered webhooks
   */
  async dispatchEvent(request: DispatchEventRequest): Promise<void> {
    const { event, projectId } = request;

    this.log('log', 'Dispatching webhook event', {
      eventType: event.type,
      eventId: event.id,
    });

    this.metrics.incrementCounter('webhooks_dispatched_total', {
      event_type: event.type,
    });

    // Find all endpoints subscribed to this event type
    const endpoints = await this.findSubscribedEndpoints(event.type, projectId);

    if (endpoints.length === 0) {
      this.log('log', 'No endpoints subscribed to event type', {
        eventType: event.type,
      });
      return;
    }

    this.log('log', 'Found subscribed endpoints', {
      eventType: event.type,
      endpointCount: endpoints.length,
    });

    // Create delivery records for each endpoint
    for (const endpoint of endpoints) {
      await this.createDelivery(endpoint, event);
    }

    // Attempt immediate delivery (async)
    this.processDeliveries().catch((err) =>
      this.log('error', 'Background delivery processing failed', {
        error: err?.message ?? String(err),
      }),
    );
  }

  /**
   * Processes pending deliveries
   */
  async processDeliveries(): Promise<{
    delivered: number;
    failed: number;
    retrying: number;
  }> {
    const startTime = Date.now();

    // Find deliveries that need to be attempted
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: {
        OR: [
          { status: DeliveryStatus.PENDING },
          {
            status: DeliveryStatus.RETRYING,
            nextRetryAt: { lte: new Date() },
          },
        ],
        attempts: { lt: this.retryService.getMaxRetries() },
      },
      include: {
        endpoint: true,
      },
      take: 100, // Process in batches
    });

    let delivered = 0;
    let failed = 0;
    let retrying = 0;

    for (const delivery of deliveries) {
      try {
        const result = await this.attemptDelivery(delivery);

        if (result === DeliveryStatus.DELIVERED) {
          delivered++;
        } else if (result === DeliveryStatus.FAILED) {
          failed++;
        } else if (result === DeliveryStatus.RETRYING) {
          retrying++;
        }
      } catch (error) {
        this.log('error', 'Delivery attempt failed', {
          deliveryId: delivery.id,
          error: (error as Error)?.message ?? String(error),
        });
        failed++;
      }
    }

    const duration = Date.now() - startTime;
    this.log('log', 'Processed webhook deliveries', {
      total: deliveries.length,
      delivered,
      failed,
      retrying,
      durationMs: duration,
    });

    return { delivered, failed, retrying };
  }

  /**
   * Attempts to deliver a webhook
   */
  private async attemptDelivery(delivery: any): Promise<DeliveryStatus> {
    const { endpoint } = delivery;

    // Skip disabled endpoints
    if (endpoint.status !== EndpointStatus.ACTIVE) {
      this.log('warn', 'Skipping delivery to disabled endpoint', {
        endpointId: endpoint.id,
        deliveryId: delivery.id,
      });
      return DeliveryStatus.FAILED;
    }

    const attemptNumber = delivery.attempts + 1;
    const maxRetries = this.retryService.getMaxRetries();

    this.logger.log(
      `Attempting delivery ${delivery.id} to ${endpoint.url} (attempt ${attemptNumber}/${maxRetries})`,
    );

    // Dispatch the webhook
    const dispatchResult = await this.dispatchService.deliverWebhook(
      endpoint.url,
      delivery.payload,
      delivery.eventType,
      delivery.eventId,
      endpoint.secret,
    );

    const responseTimeSeconds = dispatchResult.responseTime / 1000;

    if (dispatchResult.success) {
      // Success!
      await this.markDelivered(
        delivery.id,
        dispatchResult.responseStatus!,
        dispatchResult.responseBody,
        dispatchResult.responseTime,
      );
      await this.retryService.markEndpointSuccess(endpoint.id);

      this.metrics.incrementCounter('webhooks_delivered_total', {
        event_type: delivery.eventType,
        result: 'success',
      });
      this.metrics.recordHistogram(
        'webhook_delivery_duration_seconds',
        responseTimeSeconds,
        { event_type: delivery.eventType },
      );

      return DeliveryStatus.DELIVERED;
    }

    // Delivery failed - determine if we should retry
    const axiosError = new AxiosError(
      dispatchResult.errorMessage,
      '',
      undefined,
      null,
      { status: dispatchResult.responseStatus } as any,
    );

    const shouldRetry =
      attemptNumber < maxRetries &&
      this.dispatchService.isRetryableError(axiosError);

    if (shouldRetry) {
      const nextRetryAt = this.retryService.calculateNextRetry(attemptNumber);
      await this.retryService.markRetrying(
        delivery.id,
        attemptNumber,
        nextRetryAt,
        dispatchResult.responseStatus,
        dispatchResult.responseBody || '',
        dispatchResult.responseTime,
        dispatchResult.errorMessage || '',
        delivery.eventType,
      );
      this.metrics.recordHistogram(
        'webhook_delivery_duration_seconds',
        responseTimeSeconds,
        { event_type: delivery.eventType },
      );
      return DeliveryStatus.RETRYING;
    }

    // Failed and no more retries
    await this.retryService.handleDeliveryFailure(
      delivery.id,
      endpoint.id,
      attemptNumber,
      dispatchResult.responseStatus,
      dispatchResult.responseBody || '',
      dispatchResult.responseTime,
      dispatchResult.errorMessage || '',
      delivery.eventType,
    );
    this.metrics.recordHistogram(
      'webhook_delivery_duration_seconds',
      responseTimeSeconds,
      { event_type: delivery.eventType },
    );

    return DeliveryStatus.FAILED;
  }

  /**
   * Finds endpoints subscribed to an event type
   */
  private async findSubscribedEndpoints(eventType: string, projectId?: string) {
    return await this.prisma.webhookEndpoint.findMany({
      where: {
        status: EndpointStatus.ACTIVE,
        events: { has: eventType },
        ...(projectId ? { projectId } : {}),
      },
    });
  }

  /**
   * Creates a delivery record
   */
  private async createDelivery(
    endpoint: any,
    event: WebhookEvent,
  ): Promise<void> {
    await this.prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId: event.id,
        eventType: event.type,
        payload: JSON.parse(JSON.stringify(event)),
        status: DeliveryStatus.PENDING,
        attempts: 0,
        maxAttempts: this.retryService.getMaxRetries(),
      },
    });
  }

  /**
   * Marks delivery as delivered
   */
  private async markDelivered(
    deliveryId: string,
    status: number,
    body: any,
    responseTime: number,
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DeliveryStatus.DELIVERED,
        deliveredAt: new Date(),
        lastAttemptAt: new Date(),
        responseStatus: status,
        responseBody: JSON.stringify(body).substring(0, 1000),
        responseTime,
      },
    });
  }
}
