/**
 * Validates required environment variables at startup.
 * Fail-fast: throws if any required variable is missing or invalid.
 */

import { DEFAULT_BALANCE_STALE_THRESHOLD_MS } from '../balance-indexer/balance-indexer.error-codes';
import {
  resolveDatabasePoolConfig,
  validateDatabasePoolEnv,
} from '../prisma/database-pool.config';

export interface ValidatedEnv {
  PORT: number;
  DATABASE_URL: string;
  STELLAR_NETWORK: 'mainnet' | 'testnet';
  JSON_BODY_LIMIT_BYTES: number;
  /** Balance staleness budget in ms; positive integer (default 5 minutes). */
  BALANCE_STALE_THRESHOLD_MS: number;
  /** Optional Prisma/Postgres pool ceiling (#951). */
  DATABASE_POOL_SIZE?: number;
  /** Optional Prisma `pool_timeout` in seconds (#951). */
  DATABASE_POOL_TIMEOUT_SECONDS?: number;
  /** Optional Prisma `connect_timeout` in seconds (#951). */
  DATABASE_CONNECT_TIMEOUT_SECONDS?: number;
  CORS_ORIGINS: string;
  MAINNET_PAYMENT_ENABLED: boolean;
  NODE_ENV: string;
  LOG_LEVEL: string;
}

const PLACEHOLDER_WALLET_ENCRYPTION_KEY =
  'your-secret-encryption-key-min-32-chars';
const PLACEHOLDER_WEBHOOK_SIGNING_KEY =
  'your-secure-webhook-signing-key-min-32-chars';

const REQUIRED_VARS = [
  'DATABASE_URL',
  'STELLAR_NETWORK',
] as const;

const DEFAULTS = {
  PORT: 3000,
  JSON_BODY_LIMIT_BYTES: 1024 * 1024, // 1MB
  CORS_ORIGINS: 'http://localhost:3000',
  MAINNET_PAYMENT_ENABLED: false,
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
} as const;

/**
 * Per-variable numeric bounds (#1275). A parsed value must be finite and
 * within [min, max]; otherwise it is a validation error, not a fallback.
 */
interface NumberBounds {
  min: number;
  max: number;
  integer?: boolean;
}

const NUMBER_BOUNDS: Record<string, NumberBounds> = {
  PORT: { min: 1, max: 65535, integer: true },
  JSON_BODY_LIMIT_BYTES: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  BALANCE_SYNC_INTERVAL_MS: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  BALANCE_SYNC_MAX_RETRIES: { min: 0, max: 1000, integer: true },
  BALANCE_STALE_THRESHOLD_MS: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  WEBHOOK_MAX_RETRIES: { min: 0, max: 1000, integer: true },
  WEBHOOK_RETRY_BACKOFF_MS: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
  WEBHOOK_TIMEOUT_MS: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  WEBHOOK_MAX_CONSECUTIVE_FAILURES: { min: 0, max: 1000, integer: true },
  WEBHOOK_QUEUE_INTERVAL_MS: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  RECOVERY_REQUEST_TTL_MS: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  AUTH_RATE_LIMIT_MAX: { min: 1, max: 1000000, integer: true },
  AUTH_RATE_LIMIT_WINDOW_MS: { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true },
  API_KEY_DEFAULT_EXPIRY_DAYS: { min: 0, max: 36500, integer: true },
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Parses a boolean env var, pushing a named error when the value is present
 * but not one of the accepted truthy/falsy tokens. Returns the fallback when
 * absent. Used for fail-closed switches where a typo must not silently
 * resolve to disabled.
 */
function parseRequiredBoolean(
  value: string | undefined,
  fallback: boolean,
  variable: string,
  errors: string[],
): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  errors.push(
    `${variable} must be one of: true, false, 1, 0, yes, no, on, off`,
  );
  return fallback;
}

/**
 * Validates a raw numeric string against the per-variable bounds. Returns the
 * parsed number, or `undefined` when the value is not finite or out of range.
 */
function parseBoundedNumber(
  raw: string,
  variable: string,
): { value?: number; error?: string } {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return { error: `${variable} must be a finite number` };
  }
  const bounds = NUMBER_BOUNDS[variable];
  if (bounds) {
    if (bounds.integer && !Number.isInteger(parsed)) {
      return { error: `${variable} must be an integer` };
    }
    if (parsed < bounds.min || parsed > bounds.max) {
      return {
        error: `${variable} must be between ${bounds.min} and ${bounds.max}`,
      };
    }
  }
  return { value: parsed };
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  variable?: string,
  errors?: string[],
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const name = variable ?? 'value';
  const { value: parsed, error } = parseBoundedNumber(String(value).trim(), name);
  if (error) {
    if (errors) {
      errors.push(error);
    }
    return fallback;
  }
  return parsed as number;
}

/**
 * Parses a numeric env var, pushing a named error when the value is present
 * but not a valid number. Returns the fallback when absent.
 */
function parseRequiredNumber(
  value: string | undefined,
  fallback: number,
  variable: string,
  errors: string[],
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const { value: parsed, error } = parseBoundedNumber(String(value).trim(), variable);
  if (error) {
    errors.push(error);
    return fallback;
  }
  return parsed as number;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return ['http://localhost:3000'];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Validates and returns typed environment configuration.
 * Throws on missing required variables.
 */
export function validateEnv(
  env: NodeJS.ProcessEnv = process.env,
): ValidatedEnv {
  const errors: string[] = [];

  // --- Core required variables ---

  const NODE_ENV = env.NODE_ENV ?? 'development';

  const PORT = parseNumber(env.PORT, 3000, 'PORT', errors);

  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) {
    errors.push('DATABASE_URL is required');
  }

  const WALLET_ENCRYPTION_KEY = env.WALLET_ENCRYPTION_KEY;
  if (!WALLET_ENCRYPTION_KEY) {
    errors.push(
      'WALLET_ENCRYPTION_KEY is required (generate with: openssl rand -hex 32)',
    );
  } else if (WALLET_ENCRYPTION_KEY.length < 32) {
    errors.push('WALLET_ENCRYPTION_KEY must be at least 32 characters long');
  } else if (
    WALLET_ENCRYPTION_KEY.includes(PLACEHOLDER_WALLET_ENCRYPTION_KEY)
  ) {
    errors.push('WALLET_ENCRYPTION_KEY cannot be the placeholder value');
  }

  const STELLAR_HORIZON_URL = env.STELLAR_HORIZON_URL;
  if (!STELLAR_HORIZON_URL) {
    errors.push(
      'STELLAR_HORIZON_URL is required (e.g., https://horizon-testnet.stellar.org)',
    );
  } else {
    try {
      new URL(STELLAR_HORIZON_URL);
    } catch {
      errors.push('STELLAR_HORIZON_URL must be a valid URL');
    }
  }

  const STELLAR_NETWORK = (env.STELLAR_NETWORK ?? 'TESTNET').toUpperCase();
  if (!['TESTNET', 'PUBLIC'].includes(STELLAR_NETWORK)) {
    errors.push('STELLAR_NETWORK must be either TESTNET or PUBLIC');
  }

  const WEBHOOK_SIGNING_KEY = env.WEBHOOK_SIGNING_KEY;
  if (!WEBHOOK_SIGNING_KEY) {
    errors.push(
      'WEBHOOK_SIGNING_KEY is required (generate with: openssl rand -hex 32)',
    );
  } else if (WEBHOOK_SIGNING_KEY.length < 32) {
    errors.push('WEBHOOK_SIGNING_KEY must be at least 32 characters long');
  } else if (WEBHOOK_SIGNING_KEY.includes(PLACEHOLDER_WEBHOOK_SIGNING_KEY)) {
    errors.push('WEBHOOK_SIGNING_KEY cannot be the placeholder value');
  }

  // --- Optional variables with defaults ---

  // Canonical mainnet payment enable switch (#1181). Must match the name read
  // by resolveMainnetPaymentFlag() in src/config/configuration.ts.
  const MAINNET_PAYMENT_ENABLED = parseRequiredBoolean(
    env.MAINNET_PAYMENT_ENABLED,
    false,
    'MAINNET_PAYMENT_ENABLED',
    errors,
  );
  const BALANCE_SYNC_INTERVAL_MS = parseNumber(
    env.BALANCE_SYNC_INTERVAL_MS,
    600000,
    'BALANCE_SYNC_INTERVAL_MS',
    errors,
  );
  const BALANCE_SYNC_MAX_RETRIES = parseNumber(
    env.BALANCE_SYNC_MAX_RETRIES,
    3,
    'BALANCE_SYNC_MAX_RETRIES',
    errors,
  );
  // A zero, negative, fractional or non-numeric budget would silently make
  // every balance stale (or never stale), so reject it at boot.
  const BALANCE_STALE_THRESHOLD_MS = parseRequiredNumber(
    env.BALANCE_STALE_THRESHOLD_MS,
    DEFAULT_BALANCE_STALE_THRESHOLD_MS,
    'BALANCE_STALE_THRESHOLD_MS',
    errors,
  );
  if (
    !Number.isInteger(BALANCE_STALE_THRESHOLD_MS) ||
    BALANCE_STALE_THRESHOLD_MS <= 0
  ) {
    errors.push('BALANCE_STALE_THRESHOLD_MS must be a positive integer');
  }
  const CORS_ORIGINS = parseCorsOrigins(env.CORS_ORIGINS);
  const WEBHOOK_MAX_RETRIES = parseNumber(
    env.WEBHOOK_MAX_RETRIES,
    5,
    'WEBHOOK_MAX_RETRIES',
    errors,
  );
  const WEBHOOK_RETRY_BACKOFF_MS = parseNumber(
    env.WEBHOOK_RETRY_BACKOFF_MS,
    1000,
    'WEBHOOK_RETRY_BACKOFF_MS',
    errors,
  );
  const WEBHOOK_TIMEOUT_MS = parseNumber(
    env.WEBHOOK_TIMEOUT_MS,
    10000,
    'WEBHOOK_TIMEOUT_MS',
    errors,
  );
  const WEBHOOK_MAX_CONSECUTIVE_FAILURES = parseNumber(
    env.WEBHOOK_MAX_CONSECUTIVE_FAILURES,
    10,
    'WEBHOOK_MAX_CONSECUTIVE_FAILURES',
    errors,
  );
  const WEBHOOK_QUEUE_INTERVAL_MS = parseNumber(
    env.WEBHOOK_QUEUE_INTERVAL_MS,
    30000,
    'WEBHOOK_QUEUE_INTERVAL_MS',
    errors,
  );
  const WEBHOOK_INBOUND_SECRET =
    env.WEBHOOK_INBOUND_SECRET ?? 'your-inbound-webhook-secret';
  const RECOVERY_REQUEST_TTL_MS = parseNumber(
    env.RECOVERY_REQUEST_TTL_MS,
    604800000,
    'RECOVERY_REQUEST_TTL_MS',
    errors,
  );
  const FEATURE_MAINNET_PAYMENT_SUBMIT = parseBoolean(
    env.FEATURE_MAINNET_PAYMENT_SUBMIT,
    false,
  );
  const STELLAR_SPONSOR_SECRET_KEY = env.STELLAR_SPONSOR_SECRET_KEY;
  const AUTH_RATE_LIMIT_MAX = parseNumber(
    env.AUTH_RATE_LIMIT_MAX,
    10,
    'AUTH_RATE_LIMIT_MAX',
    errors,
  );
  const AUTH_RATE_LIMIT_WINDOW_MS = parseNumber(
    env.AUTH_RATE_LIMIT_WINDOW_MS,
    60000,
    'AUTH_RATE_LIMIT_WINDOW_MS',
    errors,
  );
  const API_KEY_DEFAULT_EXPIRY_DAYS = env.API_KEY_DEFAULT_EXPIRY_DAYS
    ? parseNumber(
        env.API_KEY_DEFAULT_EXPIRY_DAYS,
        0,
        'API_KEY_DEFAULT_EXPIRY_DAYS',
        errors,
      )
    : undefined;
  const OTEL_ENABLED = parseBoolean(env.OTEL_ENABLED, false);
  const OTEL_EXPORTER_OTLP_ENDPOINT = env.OTEL_EXPORTER_

/* … truncated 3226 chars — edit only what you need near the top … */
