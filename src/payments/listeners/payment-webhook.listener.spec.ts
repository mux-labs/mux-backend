import { PaymentWebhookListener } from './payment-webhook.listener';
import { WebhookEventEmitterService } from '../../webhooks/webhook-event-emitter.service';
import { PaymentCreatedEvent } from '../events/payment-created.event';
import { PaymentCompletedEvent } from '../events/payment-completed.event';
import { PaymentFailedEvent } from '../events/payment-failed.event';

describe('PaymentWebhookListener', () => {
  let listener: PaymentWebhookListener;
  let webhookEmitter: jest.Mocked<WebhookEventEmitterService>;

  beforeEach(() => {
    webhookEmitter = {
      emitPaymentCreated: jest.fn().mockResolvedValue(undefined),
      emitPaymentCompleted: jest.fn().mockResolvedValue(undefined),
      emitPaymentFailed: jest.fn().mockResolvedValue(undefined),
    } as any;

    listener = new PaymentWebhookListener(webhookEmitter);
  });

  it('bridges payment.created to webhookEmitter.emitPaymentCreated', async () => {
    const event = new PaymentCreatedEvent('pay-1', 'wallet-1', 100, 'XLM', 'user-1');

    await listener.onPaymentCreated(event);

    expect(webhookEmitter.emitPaymentCreated).toHaveBeenCalledWith({
      paymentId: 'pay-1',
      walletId: 'wallet-1',
      amount: 100,
      currency: 'XLM',
      userId: 'user-1',
    });
  });

  it('bridges payment.completed to webhookEmitter.emitPaymentCompleted', async () => {
    const event = new PaymentCompletedEvent('pay-2', 'wallet-2', 50, 'USDC', 'user-2');

    await listener.onPaymentCompleted(event);

    expect(webhookEmitter.emitPaymentCompleted).toHaveBeenCalledWith({
      paymentId: 'pay-2',
      walletId: 'wallet-2',
      amount: 50,
      currency: 'USDC',
      userId: 'user-2',
    });
  });

  it('bridges payment.failed to webhookEmitter.emitPaymentFailed', async () => {
    const event = new PaymentFailedEvent(
      'pay-3', 'wallet-3', 200, 'XLM', 'user-3', 'insufficient funds',
    );

    await listener.onPaymentFailed(event);

    expect(webhookEmitter.emitPaymentFailed).toHaveBeenCalledWith({
      paymentId: 'pay-3',
      walletId: 'wallet-3',
      amount: 200,
      currency: 'XLM',
      userId: 'user-3',
      reason: 'insufficient funds',
    });
  });

  it('does not throw when webhook dispatch fails', async () => {
    webhookEmitter.emitPaymentCreated.mockRejectedValue(new Error('dispatch error'));
    const event = new PaymentCreatedEvent('pay-4', 'wallet-4', 10, 'XLM', 'user-4');

    await expect(listener.onPaymentCreated(event)).resolves.toBeUndefined();
  });
});
