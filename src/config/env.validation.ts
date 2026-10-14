/**
 * Environment validation for Mux Backend.
 *
 * Validates all required environment variables at startup and fails fast
 * with actionable error messages if any are missing or invalid.
 * This ensures fail-closed behavior for security-critical configuration.
 */

export interface ValidatedEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  WALLET_ENCRYPTION_KEY: string;
  STELLAR_HORIZON_URL: string;
  STELLAR_NETWORK: 'TESTNET' | 'PUBLIC';
  WEBHOOK_SIGNING_KEY: string;
  MAINNET_PAYMENTS_ENABLED: boolean;
  BALANCE_SYNC_INTERVAL_MS: number;
  BALANCE_SYNC_MAX_RETRIES: number;
  CORS_ORIGINS: string[];
  WEBHOOK_MAX_RETRIES: number;
  WEBHOOK_RETRY_BACKOFF_MS: number;
  WEBHOOK_TIMEOUT_MS: number;
  WEBHOOK_MAX_CONSECUTIVE_FAILURES: number;
  WEBHOOK_QUEUE_INTERVAL_MS: number;
  WEBHOOK_INBOUND_SECRET: string;
  RECOVERY_REQUEST_TTL_MS: number;
  FEATURE_MAINNET_PAYMENT_SUBMIT: boolean;
  STELLAR_SPONSOR_SECRET_KEY?: string;
  AUTH_RATE_LIMIT_MAX: number;
  AUTH_RATE_LIMIT_WINDOW_MS: number;
  API_KEY_DEFAULT_EXPIRY_DAYS?: number;
  OTEL_ENABLED: boolean;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_SERVICE_NAME: string;
  OTEL_SERVICE_VERSION: string;
  AUTH_IDENTITY_PROVIDER: 'CLERK' | 'BETTER_AUTH';
  CLERK_JWT_PUBLIC_KEY?: string;
  BETTER_AUTH_JWKS_URL?: string;
  AUTH_SKIP_JWT_VERIFICATION: boolean;
  OTEL_EXPORTER_OTLP_PROTOCOL: string;
  JSON_BODY_LIMIT_BYTES: number;
}

const PLACEHOLDER_WALLET_ENCRYPTION_KEY = 'your-secret-encryption-key-min-32-chars';
const PLACEHOLDER_WEBHOOK_SIGNING_KEY = 'your-secure-webhook-signing-key-min-32-chars';

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

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return ['http://localhost:3000'];
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

/**
 * Validates all required environment variables.
 * Throws an Error with a descriptive message if validation fails.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): ValidatedEnv {
  const errors: string[] = [];

  // --- Core required variables ---

  const NODE_ENV = env.NODE_ENV ?? 'development';

  const PORT = parseNumber(env.PORT, 3000);

  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) {
    errors.push('DATABASE_URL is required');
  }

  const WALLET_ENCRYPTION_KEY = env.WALLET_ENCRYPTION_KEY;
  if (!WALLET_ENCRYPTION_KEY) {
    errors.push('WALLET_ENCRYPTION_KEY is required (generate with: openssl rand -hex 32)');
  } else if (WALLET_ENCRYPTION_KEY.length < 32) {
    errors.push('WALLET_ENCRYPTION_KEY must be at least 32 characters long');
  } else if (WALLET_ENCRYPTION_KEY.includes(PLACEHOLDER_WALLET_ENCRYPTION_KEY)) {
    errors.push('WALLET_ENCRYPTION_KEY cannot be the placeholder value');
  }

  const STELLAR_HORIZON_URL = env.STELLAR_HORIZON_URL;
  if (!STELLAR_HORIZON_URL) {
    errors.push('STELLAR_HORIZON_URL is required (e.g., https://horizon-testnet.stellar.org)');
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
    errors.push('WEBHOOK_SIGNING_KEY is required (generate with: openssl rand -hex 32)');
  } else if (WEBHOOK_SIGNING_KEY.length < 32) {
    errors.push('WEBHOOK_SIGNING_KEY must be at least 32 characters long');
  } else if (WEBHOOK_SIGNING_KEY.includes(PLACEHOLDER_WEBHOOK_SIGNING_KEY)) {
    errors.push('WEBHOOK_SIGNING_KEY cannot be the placeholder value');
  }

  // --- Optional variables with defaults ---

  const MAINNET_PAYMENTS_ENABLED = parseBoolean(env.MAINNET_PAYMENTS_ENABLED, false);
  const BALANCE_SYNC_INTERVAL_MS = parseNumber(env.BALANCE_SYNC_INTERVAL_MS, 600000);
  const BALANCE_SYNC_MAX_RETRIES = parseNumber(env.BALANCE_SYNC_MAX_RETRIES, 3);
  const CORS_ORIGINS = parseCorsOrigins(env.CORS_ORIGINS);
  const WEBHOOK_MAX_RETRIES = parseNumber(env.WEBHOOK_MAX_RETRIES, 5);
  const WEBHOOK_RETRY_BACKOFF_MS = parseNumber(env.WEBHOOK_RETRY_BACKOFF_MS, 1000);
  const WEBHOOK_TIMEOUT_MS = parseNumber(env.WEBHOOK_TIMEOUT_MS, 10000);
  const WEBHOOK_MAX_CONSECUTIVE_FAILURES = parseNumber(env.WEBHOOK_MAX_CONSECUTIVE_FAILURES, 10);
  const WEBHOOK_QUEUE_INTERVAL_MS = parseNumber(env.WEBHOOK_QUEUE_INTERVAL_MS, 30000);
  const WEBHOOK_INBOUND_SECRET = env.WEBHOOK_INBOUND_SECRET ?? 'your-inbound-webhook-secret';
  const RECOVERY_REQUEST_TTL_MS = parseNumber(env.RECOVERY_REQUEST_TTL_MS, 604800000);
  const FEATURE_MAINNET_PAYMENT_SUBMIT = parseBoolean(env.FEATURE_MAINNET_PAYMENT_SUBMIT, false);
  const STELLAR_SPONSOR_SECRET_KEY = env.STELLAR_SPONSOR_SECRET_KEY;
  const AUTH_RATE_LIMIT_MAX = parseNumber(env.AUTH_RATE_LIMIT_MAX, 10);
  const AUTH_RATE_LIMIT_WINDOW_MS = parseNumber(env.AUTH_RATE_LIMIT_WINDOW_MS, 60000);
  const API_KEY_DEFAULT_EXPIRY_DAYS = env.API_KEY_DEFAULT_EXPIRY_DAYS
    ? parseNumber(env.API_KEY_DEFAULT_EXPIRY_DAYS, 0)
    : undefined;
  const OTEL_ENABLED = parseBoolean(env.OTEL_ENABLED, false);
  const OTEL_EXPORTER_OTLP_ENDPOINT = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const OTEL_SERVICE_NAME = env.OTEL_SERVICE_NAME ?? 'mux-backend';
  const OTEL_SERVICE_VERSION = env.OTEL_SERVICE_VERSION ?? '1.0.0';

  const AUTH_IDENTITY_PROVIDER = (env.AUTH_IDENTITY_PROVIDER ?? 'CLERK').toUpperCase();
  if (!['CLERK', 'BETTER_AUTH'].includes(AUTH_IDENTITY_PROVIDER)) {
    errors.push('AUTH_IDENTITY_PROVIDER must be either CLERK or BETTER_AUTH');
  }

  const CLERK_JWT_PUBLIC_KEY = env.CLERK_JWT_PUBLIC_KEY;
  const BETTER_AUTH_JWKS_URL = env.BETTER_AUTH_JWKS_URL;

  // Validate provider-specific config in production
  if (NODE_ENV === 'production') {
    if (AUTH_IDENTITY_PROVIDER === 'CLERK' && !CLERK_JWT_PUBLIC_KEY) {
      errors.push('CLERK_JWT_PUBLIC_KEY is required when AUTH_IDENTITY_PROVIDER=CLERK in production');
    }
    if (AUTH_IDENTITY_PROVIDER === 'BETTER_AUTH' && !BETTER_AUTH_JWKS_URL) {
      errors.push('BETTER_AUTH_JWKS_URL is required when AUTH_IDENTITY_PROVIDER=BETTER_AUTH in production');
    }
    if (OTEL_ENABLED && !OTEL_EXPORTER_OTLP_ENDPOINT) {
      errors.push('OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true');
    } else if (OTEL_EXPORTER_OTLP_ENDPOINT) {
      try {
        new URL(OTEL_EXPORTER_OTLP_ENDPOINT);
      } catch {
        errors.push('OTEL_EXPORTER_OTLP_ENDPOINT must be a valid URL');
      }
    }
  }

  const AUTH_SKIP_JWT_VERIFICATION = parseBoolean(env.AUTH_SKIP_JWT_VERIFICATION, false);
  if (AUTH_SKIP_JWT_VERIFICATION && NODE_ENV === 'production') {
    errors.push('AUTH_SKIP_JWT_VERIFICATION must not be enabled in production');
  }

  const OTEL_EXPORTER_OTLP_PROTOCOL = env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf';
  const JSON_BODY_LIMIT_BYTES = parseNumber(env.JSON_BODY_LIMIT_BYTES, 102400); // 100 KiB default

  if (errors.length > 0) {
    const message = [
      'Environment validation failed:',
      ...errors.map((e) => `  - ${e}`),
      '',
      'Please check your .env file and ensure all required variables are set correctly.',
    ].join('\n');
    throw new Error(message);
  }

  return {
    NODE_ENV,
    PORT,
    DATABASE_URL: DATABASE_URL!,
    WALLET_ENCRYPTION_KEY: WALLET_ENCRYPTION_KEY!,
    STELLAR_HORIZON_URL: STELLAR_HORIZON_URL!,
    STELLAR_NETWORK: STELLAR_NETWORK as 'TESTNET' | 'PUBLIC',
    WEBHOOK_SIGNING_KEY: WEBHOOK_SIGNING_KEY!,
    MAINNET_PAYMENTS_ENABLED,
    BALANCE_SYNC_INTERVAL_MS,
    BALANCE_SYNC_MAX_RETRIES,
    CORS_ORIGINS,
    WEBHOOK_MAX_RETRIES,
    WEBHOOK_RETRY_BACKOFF_MS,
    WEBHOOK_TIMEOUT_MS,
    WEBHOOK_MAX_CONSECUTIVE_FAILURES,
    WEBHOOK_QUEUE_INTERVAL_MS,
    WEBHOOK_INBOUND_SECRET,
    RECOVERY_REQUEST_TTL_MS,
    FEATURE_MAINNET_PAYMENT_SUBMIT,
    STELLAR_SPONSOR_SECRET_KEY,
    AUTH_RATE_LIMIT_MAX,
    AUTH_RATE_LIMIT_WINDOW_MS,
    API_KEY_DEFAULT_EXPIRY_DAYS,
    OTEL_ENABLED,
    OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_SERVICE_NAME,
    OTEL_SERVICE_VERSION,
    AUTH_IDENTITY_PROVIDER: AUTH_IDENTITY_PROVIDER as 'CLERK' | 'BETTER_AUTH',
    CLERK_JWT_PUBLIC_KEY,
    BETTER_AUTH_JWKS_URL,
    AUTH_SKIP_JWT_VERIFICATION,
    OTEL_EXPORTER_OTLP_PROTOCOL,
    JSON_BODY_LIMIT_BYTES,
  };
}
