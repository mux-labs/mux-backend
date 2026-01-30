import { Injectable, Logger } from '@nestjs/common';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookEvent, WebhookEventType } from './domain/webhook-events';
import * as crypto from 'crypto';

/**
 * Service for emitting webhook events from application code
 *
 * Usage:
 * await this.webhookEventEmitter.emitWalletCreated({
 *   walletId: 'wallet-123',
 *   userId: 'user-456',
 *   publicKey: 'GABC...',
 * });
 */
@Injectable()
export class WebhookEventEmitterService {
  private readonly logger = new Logger(WebhookEventEmitterService.name);

  constructor(private readonly webhookDispatcher: WebhookDispatcherService) {}

  /**
   * Emits a wallet.created event
   */
  async emitWalletCreated(data: {
    walletId: string;
    userId: string;
    publicKey: string;
    network: string;
    status: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.WALLET_CREATED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a wallet.activated event
   */
  async emitWalletActivated(data: {
    walletId: string;
    userId: string;
    publicKey: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.WALLET_ACTIVATED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a wallet.suspended event
   */
  async emitWalletSuspended(data: {
    walletId: string;
    userId: string;
    reason?: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.WALLET_SUSPENDED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a transaction.created event
   */
  async emitTransactionCreated(data: {
    transactionId: string;
    walletId: string;
    amount: string;
    asset: string;
    destination: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.TRANSACTION_CREATED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a transaction.pending event
   */
  async emitTransactionPending(data: {
    transactionId: string;
    walletId: string;
    txHash: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.TRANSACTION_PENDING, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a transaction.confirmed event
   */
  async emitTransactionConfirmed(data: {
    transactionId: string;
    walletId: string;
    txHash: string;
    ledger: number;
    confirmations: number;
  }): Promise<void> {
    const event = this.createEvent(
      WebhookEventType.TRANSACTION_CONFIRMED,
      data,
    );
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a transaction.failed event
   */
  async emitTransactionFailed(data: {
    transactionId: string;
    walletId: string;
    reason: string;
    errorCode?: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.TRANSACTION_FAILED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a balance.updated event
   */
  async emitBalanceUpdated(data: {
    walletId: string;
    asset: string;
    previousBalance: string;
    newBalance: string;
    change: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.BALANCE_UPDATED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a balance.low event
   */
  async emitBalanceLow(data: {
    walletId: string;
    asset: string;
    currentBalance: string;
    threshold: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.BALANCE_LOW, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a user.created event
   */
  async emitUserCreated(data: {
    userId: string;
    email?: string;
    authProvider: string;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.USER_CREATED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Emits a user.updated event
   */
  async emitUserUpdated(data: {
    userId: string;
    changes: Record<string, any>;
  }): Promise<void> {
    const event = this.createEvent(WebhookEventType.USER_UPDATED, data);
    await this.webhookDispatcher.dispatchEvent({ event });
  }

  /**
   * Creates a webhook event with standard structure
   */
  private createEvent(
    type: WebhookEventType,
    data: Record<string, any>,
  ): WebhookEvent {
    return {
      id: `evt_${crypto.randomBytes(16).toString('hex')}`,
      type,
      createdAt: new Date(),
      data,
    };
  }
}
