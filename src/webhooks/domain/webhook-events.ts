/**
 * Domain types for webhook events
 */

export enum WebhookEventType {
  // Wallet events
  WALLET_CREATED = 'wallet.created',
  WALLET_ACTIVATED = 'wallet.activated',
  WALLET_SUSPENDED = 'wallet.suspended',
  WALLET_ROTATED = 'wallet.rotated',

  // Transaction events
  TRANSACTION_CREATED = 'transaction.created',
  TRANSACTION_PENDING = 'transaction.pending',
  TRANSACTION_CONFIRMED = 'transaction.confirmed',
  TRANSACTION_FAILED = 'transaction.failed',

  // Balance events
  BALANCE_UPDATED = 'balance.updated',
  BALANCE_LOW = 'balance.low',

  // User events
  USER_CREATED = 'user.created',
  USER_UPDATED = 'user.updated',
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  createdAt: Date;
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface WebhookEndpoint {
  id: string;
  projectId: string;
  url: string;
  description?: string | null;
  secret: string;
  events: string[];
  status: string;
  consecutiveFailures: number;
  lastFailureAt?: Date | null;
  lastFailureReason?: string | null;
  lastSuccessAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: any;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: Date | null;
  responseStatus?: number | null;
  responseBody?: string | null;
  responseTime?: number | null;
  firstAttemptAt?: Date | null;
  lastAttemptAt?: Date | null;
  deliveredAt?: Date | null;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export enum DeliveryStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING',
}

export enum EndpointStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
  FAILED = 'FAILED',
}
