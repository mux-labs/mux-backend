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
  BALANCE_MISMATCH = 'balance.mismatch',

  // User events
  USER_CREATED = 'user.created',
  USER_UPDATED = 'user.updated',

  // Auth / session events
  AUTH_USER_AUTHENTICATED = 'auth.user_authenticated',
  AUTH_NEW_USER_REGISTERED = 'auth.new_user_registered',
  AUTH_AUTHENTICATION_FAILED = 'auth.authentication_failed',
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
  /** SHA-256 hash of the derived signing secret — the plaintext is never stored. */
  secretHash: string;
  /** Version of the derived signing secret currently used to sign deliveries. */
  secretVersion: number;
  /** Version staged by rotate-secret while the previous one stays active. */
  pendingSecretVersion?: number | null;
  /** SHA-256 hash of the pending derived signing secret. */
  pendingSecretHash?: string | null;
  /** When the pending secret becomes active (null = no rotation in progress). */
  secretGracePeriodEndsAt?: Date | null;
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
