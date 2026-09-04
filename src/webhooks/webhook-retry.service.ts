import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Webhook Retry Service
 *
 * Responsible only for:
 * - Retry scheduling and exponential backoff
 * - Dead letter queue logic
 * - Endpoint failure tracking
 */
@Injectable()
export class WebhookRetryService {
  private readonly logger = new Logger(WebhookRetryService.name);

  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly maxConsecutiveFailures: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.maxRetries = this.configService.get<number>('WEBHOOK_MAX_RETRIES', 5);
    this.retryBackoffMs = this.configService.get<number>(
      'WEBHOOK_RETRY_BACKOFF_MS',
      1000,
    );
    this.maxConsecutiveFailures = this.configService.get<number>(
      'WEBHOOK_MAX_CONSECUTIVE_FAILURES',
      10,
    );
  }

  /**
   * Calculates next retry time with exponential backoff
   */
  calculateNextRetry(attemptNumber: number): Date {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delayMs = this.retryBackoffMs * Math.pow(2, attemptNumber - 1);
    return new Date(Date.now() + delayMs);
  }

  /**
   * Marks a delivery as retrying and schedules the next attempt
   */
  async markRetrying(
    deliveryId: string,
    attempts: number,
    nextRetryAt: Date,
    responseStatus: number | undefined,
    responseBody: string,
    responseTime: number,
    errorMessage: string,
    eventType: string,
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'RETRYING',
        attempts,
        nextRetryAt,
        lastAttemptAt: new Date(),
        firstAttemptAt: attempts === 1 ? new Date() : undefined,
        responseStatus,
        responseBody: responseBody.substring(0, 1000),
        responseTime,
        errorMessage: errorMessage.substring(0, 500),
      },
    });

    this.metrics.incrementCounter('webhooks_retry_total', {
      event_type: eventType,
    });
  }

  /**
   * Handles delivery failure and decides if endpoint should be disabled
   */
  async handleDeliveryFailure(
    deliveryId: string,
    endpointId: string,
    attempts: number,
    responseStatus: number | undefined,
    responseBody: string,
    responseTime: number,
    errorMessage: string,
    eventType: string,
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'FAILED',
        attempts,
        lastAttemptAt: new Date(),
        responseStatus,
        responseBody: responseBody.substring(0, 1000),
        responseTime,
        errorMessage: errorMessage.substring(0, 500),
      },
    });

    this.metrics.incrementCounter('webhooks_delivered_total', {
      event_type: eventType,
      result: 'failure',
    });

    // Mark endpoint failure and check if should be disabled
    await this.markEndpointFailure(endpointId, errorMessage);

    if (attempts >= this.maxRetries) {
      this.metrics.incrementCounter('webhooks_dead_letter_total', {
        event_type: eventType,
      });
    }
  }

  /**
   * Marks endpoint success and resets failure count
   */
  async markEndpointSuccess(endpointId: string): Promise<void> {
    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        consecutiveFailures: 0,
        lastSuccessAt: new Date(),
      },
    });
  }

  /**
   * Marks endpoint failure and disables if needed
   */
  private async markEndpointFailure(
    endpointId: string,
    reason: string,
  ): Promise<void> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    if (!endpoint) return;

    const newFailureCount = endpoint.consecutiveFailures + 1;
    const shouldDisable = newFailureCount >= this.maxConsecutiveFailures;

    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        consecutiveFailures: newFailureCount,
        lastFailureAt: new Date(),
        lastFailureReason: reason.substring(0, 500),
        status: shouldDisable ? 'FAILED' : endpoint.status,
      },
    });

    if (shouldDisable) {
      this.logger.warn(
        `Disabled endpoint ${endpointId} after ${newFailureCount} consecutive failures`,
      );
    }
  }

  /**
   * Gets the maximum number of retry attempts
   */
  getMaxRetries(): number {
    return this.maxRetries;
  }
}
