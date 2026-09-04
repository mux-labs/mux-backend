import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebhookEventEmitterService } from '../../webhooks/webhook-event-emitter.service';
import { PaymentCreatedEvent } from '../events/payment-created.event';
import { PaymentCompletedEvent } from '../events/payment-completed.event';
import { PaymentFailedEvent } from '../events/payment-failed.event';

@Injectable()
export class PaymentWebhookListener {
  private readonly logger = new Logger(PaymentWebhookListener.name);

  constructor(
    private readonly webhookEmitter: WebhookEventEmitterService,
  ) {}

  @OnEvent('payment.created')
  async onPaymentCreated(event: PaymentCreatedEvent): Promise<void> {
    try {
      await this.webhookEmitter.emitPaymentCreated({
        paymentId: event.paymentId,
        walletId: event.walletId,
        amount: event.amount,
        currency: event.currency,
        userId: event.userId,
      });
    } catch (err) {
      this.logger.error(
        `Failed to dispatch payment.created webhook for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent('payment.completed')
  async onPaymentCompleted(event: PaymentCompletedEvent): Promise<void> {
    try {
      await this.webhookEmitter.emitPaymentCompleted({
        paymentId: event.paymentId,
        walletId: event.walletId,
        amount: event.amount,
        currency: event.currency,
        userId: event.userId,
      });
    } catch (err) {
      this.logger.error(
        `Failed to dispatch payment.completed webhook for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent('payment.failed')
  async onPaymentFailed(event: PaymentFailedEvent): Promise<void> {
    try {
      await this.webhookEmitter.emitPaymentFailed({
        paymentId: event.paymentId,
        walletId: event.walletId,
        amount: event.amount,
        currency: event.currency,
        userId: event.userId,
        reason: event.reason,
      });
    } catch (err) {
      this.logger.error(
        `Failed to dispatch payment.failed webhook for payment ${event.paymentId}: ${(err as Error).message}`,
      );
    }
  }
}
