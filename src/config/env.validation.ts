/**
 * Startup environment validation
 *
 * Validates all required and optional environment variables before the NestJS
 * application starts. Any missing required variable or out-of-range value
 * causes an immediate process exit with a human-readable error listing every
 * problem found.
 *
 * Usage — called once in main.ts before NestFactory.create():
 *
 *   import { validateEnv } from './config/env.validation';
 *   validateEnv(process.env);
 */

export interface EnvViolation {
  variable: string;
  message: string;
}

export interface ValidatedEnv {
  DATABASE_URL: string;
  PORT: number;
  JSON_BODY_LIMIT_BYTES: number;
  MAINTENANCE_ADMIN_SECRET: string;
  CRON_SECRET: string;
  WALLET_ENCRYPTION_KEY: string;
  WALLET_ENCRYPTION_KEY_PREVIOUS: string;
  EXPORT_SIGNING_SECRET: string;
  STELLAR_HORIZON_URL: string;
  STELLAR_HORIZON_MAX_RETRIES: number;
  BALANCE_STALE_THRESHOLD_MS: number;
  BALANCE_SYNC_INTERVAL_MS: number;
  BALANCE_SYNC_MAX_RETRIES: number;
  CORS_ORIGINS: string[];
  WEBHOOK_MAX_RETRIES: number;
  WEBHOOK_RETRY_BACKOFF_MS: number;
  WEBHOOK_TIMEOUT_MS: number;
  WEBHOOK_MAX_CONSECUTIVE_FAILURES: number;
  WEBHOOK_QUEUE_INTERVAL_MS: number;
  WEBHOOK_INBOUND_SECRET: string;
  AUTH_RATE_LIMIT_MAX: number;
  AUTH_RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
  RATE_LIMIT_SENSITIVE_WINDOW_MS: number;
  RATE_LIMIT_SENSITIVE_MAX_REQUESTS: number;
  API_KEY_ROTATION_GRACE_SECONDS: number;
  KEY_MGMT_MAX_RETRIES: number;
  KEY_MGMT_RETRY_BACKOFF_MS: number;
  BLOCK_SELF_PAYMENTS: boolean;
  AUTH_IDENTITY_PROVIDER: string;
  CLERK_JWT_PUBLIC_KEY: string;
  BETTER_AUTH_JWKS_URL: string;
  // OpenTelemetry / tracing
  OTEL_ENABLED: boolean;
  OTEL_EXPORTER_OTLP_ENDPOINT: string;
  OTEL_EXPORTER_OTLP_PROTOCOL: string;
  OTEL_SERVICE_NAME: string;
}

/**
 * Known placeholder values shipped in `.env.example` / documentation. These are
 * never acceptable as a real encryption secret — `EncryptionService` already
 * rejects them at construction time, and `validateEnv()` fails fast on them so
 * the process never even reaches Nest bootstrap with an insecure key.
 */
const PLACEHOLDER_ENCRYPTION_KEYS: ReadonlySet<string> = new Set([
  'your-secret-encryption-key-min-32-chars',
  'your-secure-encryption-key-min-32-chars-long',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireString(
  env: NodeJS.ProcessEnv,
  key: string,
  violations: EnvViolation[],
): string {
  const val = env[key];
  if (!val || val.trim().length === 0) {
    violations.push({ variable: key, message: `${key} is required` });
    return '';
  }
  return val.trim();
}

function optionalInt(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
  violations: EnvViolation[],
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    violations.push({
      variable: key,
      message: `${key} must be an integer (received "${raw}")`,
    });
    return defaultValue;
  }
  if (options.min !== undefined && parsed < options.min) {
    violations.push({
      variable: key,
      message: `${key} must be >= ${options.min} (received ${parsed})`,
    });
  }
  if (options.max !== undefined && parsed > options.max) {
    violations.push({
      variable: key,
      message: `${key} must be <= ${options.max} (received ${parsed})`,
    });
  }
  return parsed;
}

function requireUrl(
  env: NodeJS.ProcessEnv,
  key: string,
  violations: EnvViolation[],
): string {
  const val = requireString(env, key, violations);
  if (!val) return '';
  try {
    const url = new URL(val);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      violations.push({
        variable: key,
        message: `${key} must use http or https protocol (received "${val}")`,
      });
    }
  } catch {
    violations.push({
      variable: key,
      message: `${key} must be a valid URL (received "${val}")`,
    });
  }
  return val;
}

function requireDatabaseUrl(
  env: NodeJS.ProcessEnv,
  key: string,
  violations: EnvViolation[],
): string {
  const val = requireString(env, key, violations);
  if (!val) return '';
  // Accept postgresql:// or postgres:// schemes
  if (!/^postgres(ql)?:\/\//i.test(val)) {
    violations.push({
      variable: key,
      message: `${key} must be a PostgreSQL connection string starting with postgresql:// or postgres:// (received scheme: "${val.split(':')[0]}")`,
    });
  }
  return val;
}

function requireMinLength(
  env: NodeJS.ProcessEnv,
  key: string,
  minLength: number,
  violations: EnvViolation[],
): string {
  const val = requireString(env, key, violations);
  if (!val) return '';
  if (val.length < minLength) {
    violations.push({
      variable: key,
      message: `${key} must be at least ${minLength} characters long (got ${val.length})`,
    });
  }
  return val;
}

function requireEnum(
  env: NodeJS.ProcessEnv,
  key: string,
  allowedValues: string[],
  violations: EnvViolation[],
): string {
  const val = requireString(env, key, violations);
  if (!val) return '';
  if (!allowedValues.includes(val)) {
    violations.push({
      variable: key,
      message: `${key} must be one of: ${allowedValues.join(', ')} (received "${val}")`,
    });
  }
  return val;
}

function optionalOriginList(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: string[],
  violations: EnvViolation[],
): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        violations.push({
          variable: key,
          message: `${key} entry "${origin}" must use http or https protocol`,
        });
      }
    } catch {
      violations.push({
        variable: key,
        message: `${key} entry "${origin}" must be a valid URL`,
      });
    }
  }
  return origins.length > 0 ? origins : defaultValue;
}

function optionalBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: boolean,
  violations: EnvViolation[],
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') {
    return true;
  }
  if (lower === 'false' || lower === '0' || lower === 'no') {
    return false;
  }
  violations.push({
    variable: key,
    message: `${key} must be a boolean (true/false, received "${raw}")`,
  });
  return defaultValue;
}

// ─── Main validation function ─────────────────────────────────────────────────

/**
 * Validates the given environment object.
 *
 * @param env  Typically `process.env`.
 * @returns A fully-typed, normalised env object on success.
 * @throws  When running outside tests: exits the process with code 1.
 *          When running inside Jest (NODE_ENV=test): throws an Error instead
 *          so test assertions can catch it.
 */
export function validateEnv(env: NodeJS.ProcessEnv): ValidatedEnv {
  const violations: EnvViolation[] = [];

  // ── Required fields ───────────────────────────────────────────────────────
  const DATABASE_URL = requireDatabaseUrl(env, 'DATABASE_URL', violations);
  const WALLET_ENCRYPTION_KEY = requireMinLength(
    env,
    'WALLET_ENCRYPTION_KEY',
    32,
    violations,
  );
  if (
    WALLET_ENCRYPTION_KEY &&
    PLACEHOLDER_ENCRYPTION_KEYS.has(WALLET_ENCRYPTION_KEY)
  ) {
    violations.push({
      variable: 'WALLET_ENCRYPTION_KEY',
      message:
        'WALLET_ENCRYPTION_KEY must not use the documented placeholder value — ' +
        'generate a real secret (e.g. `openssl rand -hex 32`)',
    });
  }

  // Optional predecessor key used by the wallet key re-encryption job (#693)
  // while a master-key rotation is in flight. When set it must be a real
  // secret, distinct from the current key.
  const WALLET_ENCRYPTION_KEY_PREVIOUS =
    env.WALLET_ENCRYPTION_KEY_PREVIOUS?.trim() ?? '';
  if (WALLET_ENCRYPTION_KEY_PREVIOUS) {
    if (WALLET_ENCRYPTION_KEY_PREVIOUS.length < 32) {
      violations.push({
        variable: 'WALLET_ENCRYPTION_KEY_PREVIOUS',
        message:
          'WALLET_ENCRYPTION_KEY_PREVIOUS must be at least 32 characters long',
      });
    }
    if (PLACEHOLDER_ENCRYPTION_KEYS.has(WALLET_ENCRYPTION_KEY_PREVIOUS)) {
      violations.push({
        variable: 'WALLET_ENCRYPTION_KEY_PREVIOUS',
        message:
          'WALLET_ENCRYPTION_KEY_PREVIOUS must not use the documented placeholder value',
      });
    }
    if (
      WALLET_ENCRYPTION_KEY &&
      WALLET_ENCRYPTION_KEY_PREVIOUS === WALLET_ENCRYPTION_KEY
    ) {
      violations.push({
        variable: 'WALLET_ENCRYPTION_KEY_PREVIOUS',
        message:
          'WALLET_ENCRYPTION_KEY_PREVIOUS must differ from WALLET_ENCRYPTION_KEY',
      });
    }
  }

  const EXPORT_SIGNING_SECRET = env.EXPORT_SIGNING_SECRET?.trim() ?? '';
  if (process.env.NODE_ENV === 'production') {
    if (!EXPORT_SIGNING_SECRET) {
      violations.push({
        variable: 'EXPORT_SIGNING_SECRET',
        message: 'EXPORT_SIGNING_SECRET is required in production',
      });
    } else if (EXPORT_SIGNING_SECRET.length < 32) {
      violations.push({
        variable: 'EXPORT_SIGNING_SECRET',
        message: 'EXPORT_SIGNING_SECRET must be at least 32 characters long in production',
      });
    }
  }
  const STELLAR_HORIZON_URL = requireUrl(
    env,
    'STELLAR_HORIZON_URL',
    violations,
  );
  const MAINTENANCE_ADMIN_SECRET =
    env.MAINTENANCE_ADMIN_SECRET?.trim() ?? '';
  const RECOVERY_ADMIN_SECRET =
    process.env.NODE_ENV === 'production'
      ? requireMinLength(env, 'RECOVERY_ADMIN_SECRET', 32, violations)
      : env.RECOVERY_ADMIN_SECRET?.trim() ?? '';
  const RECOVERY_ADMIN_DEV_BYPASS = optionalBoolean(
    env,
    'RECOVERY_ADMIN_DEV_BYPASS',
    false,
    violations,
  );

  // ── Optional numeric fields ───────────────────────────────────────────────
  const PORT = optionalInt(
    env,
    'PORT',
    3000,
    { min: 1, max: 65535 },
    violations,
  );
  const JSON_BODY_LIMIT_BYTES = optionalInt(
    env,
    'JSON_BODY_LIMIT_BYTES',
    102_400,
    { min: 1, max: 10_485_760 },
    violations,
  );
  const STELLAR_HORIZON_MAX_RETRIES = optionalInt(
    env,
    'STELLAR_HORIZON_MAX_RETRIES',
    3,
    { min: 0, max: 100 },
    violations,
  );
  const BALANCE_STALE_THRESHOLD_MS = optionalInt(
    env,
    'BALANCE_STALE_THRESHOLD_MS',
    300_000,
    { min: 0 },
    violations,
  );
  const BALANCE_SYNC_INTERVAL_MS = optionalInt(
    env,
    'BALANCE_SYNC_INTERVAL_MS',
    10 * 60 * 1000,
    { min: 1_000 },
    violations,
  );
  const BALANCE_SYNC_MAX_RETRIES = optionalInt(
    env,
    'BALANCE_SYNC_MAX_RETRIES',
    3,
    { min: 0, max: 20 },
    violations,
  );
  const CORS_ORIGINS = optionalOriginList(
    env,
    'CORS_ORIGINS',
    ['http://localhost:3000'],
    violations,
  );
  const WEBHOOK_MAX_RETRIES = optionalInt(
    env,
    'WEBHOOK_MAX_RETRIES',
    5,
    { min: 0, max: 100 },
    violations,
  );
  const WEBHOOK_RETRY_BACKOFF_MS = optionalInt(
    env,
    'WEBHOOK_RETRY_BACKOFF_MS',
    1_000,
    { min: 0 },
    violations,
  );
  const WEBHOOK_TIMEOUT_MS = optionalInt(
    env,
    'WEBHOOK_TIMEOUT_MS',
    10_000,
    { min: 100 },
    violations,
  );
  const WEBHOOK_MAX_CONSECUTIVE_FAILURES = optionalInt(
    env,
    'WEBHOOK_MAX_CONSECUTIVE_FAILURES',
    10,
    { min: 1 },
    violations,
  );
  const WEBHOOK_QUEUE_INTERVAL_MS = optionalInt(
    env,
    'WEBHOOK_QUEUE_INTERVAL_MS',
    30_000,
    { min: 100 },
    violations,
  );
  const WEBHOOK_INBOUND_SECRET =
    env.WEBHOOK_INBOUND_SECRET?.trim() ?? '';
  const AUTH_RATE_LIMIT_MAX = optionalInt(
    env,
    'AUTH_RATE_LIMIT_MAX',
    10,
    { min: 1 },
    violations,
  );
  const AUTH_RATE_LIMIT_WINDOW_MS = optionalInt(
    env,
    'AUTH_RATE_LIMIT_WINDOW_MS',
    60_000,
    { min: 1_000 },
    violations,
  );
  const RATE_LIMIT_WINDOW_MS = optionalInt(
    env,
    'RATE_LIMIT_WINDOW_MS',
    60_000,
    { min: 1_000 },
    violations,
  );
  const RATE_LIMIT_MAX_REQUESTS = optionalInt(
    env,
    'RATE_LIMIT_MAX_REQUESTS',
    100,
    { min: 1 },
    violations,
  );
  const RATE_LIMIT_SENSITIVE_WINDOW_MS = optionalInt(
    env,
    'RATE_LIMIT_SENSITIVE_WINDOW_MS',
    60_000,
    { min: 1_000 },
    violations,
  );
  const RATE_LIMIT_SENSITIVE_MAX_REQUESTS = optionalInt(
    env,
    'RATE_LIMIT_SENSITIVE_MAX_REQUESTS',
    10,
    { min: 1 },
    violations,
  );
  const API_KEY_ROTATION_GRACE_SECONDS = optionalInt(
    env,
    'API_KEY_ROTATION_GRACE_SECONDS',
    3_600,
    { min: 0 },
    violations,
  );
  const KEY_MGMT_MAX_RETRIES = optionalInt(
    env,
    'KEY_MGMT_MAX_RETRIES',
    3,
    { min: 1, max: 10 },
    violations,
  );
  const KEY_MGMT_RETRY_BACKOFF_MS = optionalInt(
    env,
    'KEY_MGMT_RETRY_BACKOFF_MS',
    200,
    { min: 0 },
    violations,
  );
  const BLOCK_SELF_PAYMENTS = optionalBoolean(
    env,
    'BLOCK_SELF_PAYMENTS',
    false,
    violations,
  );

  // ── JWT Verification / Identity Provider ──────────────────────────────────
  const AUTH_IDENTITY_PROVIDER = env.AUTH_IDENTITY_PROVIDER?.trim() || '';
  const CLERK_JWT_PUBLIC_KEY = env.CLERK_JWT_PUBLIC_KEY?.trim() || '';
  const BETTER_AUTH_JWKS_URL = env.BETTER_AUTH_JWKS_URL?.trim() || '';

  // In production, fail closed if identity provider not configured
  if (process.env.NODE_ENV === 'production') {
    if (!MAINTENANCE_ADMIN_SECRET) {
      violations.push({
        variable: 'MAINTENANCE_ADMIN_SECRET',
        message: 'MAINTENANCE_ADMIN_SECRET is required in production (remote maintenance-mode toggling must not be silently disabled)',
      });
    }

    if (!AUTH_IDENTITY_PROVIDER) {
      violations.push({
        variable: 'AUTH_IDENTITY_PROVIDER',
        message:
          'AUTH_IDENTITY_PROVIDER is required in production (set to CLERK or BETTER_AUTH)',
      });
    }

    if (AUTH_IDENTITY_PROVIDER === 'CLERK' && !CLERK_JWT_PUBLIC_KEY) {
      violations.push({
        variable: 'CLERK_JWT_PUBLIC_KEY',
        message:
          'CLERK_JWT_PUBLIC_KEY is required when AUTH_IDENTITY_PROVIDER=CLERK',
      });
    }

    if (AUTH_IDENTITY_PROVIDER === 'BETTER_AUTH' && !BETTER_AUTH_JWKS_URL) {
      violations.push({
        variable: 'BETTER_AUTH_JWKS_URL',
        message:
          'BETTER_AUTH_JWKS_URL is required when AUTH_IDENTITY_PROVIDER=BETTER_AUTH',
      });
    }
  }

  // ── Cron / internal endpoints ─────────────────────────────────────────────
  const CRON_SECRET = env.CRON_SECRET?.trim() ?? '';

  // In production, fail closed: internal cron endpoints rely on CRON_SECRET
  // (X-Cron-Secret header guard), so the server must not start without it.
  if (process.env.NODE_ENV === 'production') {
    if (!CRON_SECRET) {
      violations.push({
        variable: 'CRON_SECRET',
        message: 'CRON_SECRET is required in production',
      });
    } else if (CRON_SECRET.length < 16) {
      violations.push({
        variable: 'CRON_SECRET',
        message:
          'CRON_SECRET must be at least 16 characters long in production',
      });
    }
  }

  // ── OpenTelemetry / Tracing ────────────────────────────────────────────────
  const OTEL_ENABLED = optionalBoolean(env, 'OTEL_ENABLED', false, violations);

  // When OTEL is explicitly enabled, the OTLP endpoint is required so traces
  // are not silently dropped.
  const OTEL_EXPORTER_OTLP_ENDPOINT =
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ?? '';
  const OTEL_EXPORTER_OTLP_PROTOCOL =
    env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() ?? 'http/protobuf';
  const OTEL_SERVICE_NAME = env.OTEL_SERVICE_NAME?.trim() ?? 'mux-backend';

  if (OTEL_ENABLED) {
    if (!OTEL_EXPORTER_OTLP_ENDPOINT) {
      violations.push({
        variable: 'OTEL_EXPORTER_OTLP_ENDPOINT',
        message:
          'OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true ' +
          '(e.g. http://localhost:4318)',
      });
    } else {
      // Validate that the endpoint is a valid http/https URL
      try {
        const url = new URL(OTEL_EXPORTER_OTLP_ENDPOINT);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          violations.push({
            variable: 'OTEL_EXPORTER_OTLP_ENDPOINT',
            message: `OTEL_EXPORTER_OTLP_ENDPOINT must use http or https protocol (received "${OTEL_EXPORTER_OTLP_ENDPOINT}")`,
          });
        }
      } catch {
        violations.push({
          variable: 'OTEL_EXPORTER_OTLP_ENDPOINT',
          message: `OTEL_EXPORTER_OTLP_ENDPOINT must be a valid URL (received "${OTEL_EXPORTER_OTLP_ENDPOINT}")`,
        });
      }
    }

    const allowedProtocols = ['http/protobuf', 'grpc'];
    if (!allowedProtocols.includes(OTEL_EXPORTER_OTLP_PROTOCOL)) {
      violations.push({
        variable: 'OTEL_EXPORTER_OTLP_PROTOCOL',
        message: `OTEL_EXPORTER_OTLP_PROTOCOL must be one of: ${allowedProtocols.join(', ')} (received "${OTEL_EXPORTER_OTLP_PROTOCOL}")`,
      });
    }
  }

  // ── Report violations ─────────────────────────────────────────────────────
  if (violations.length > 0) {
    const lines = violations.map((v) => `  • ${v.message}`).join('\n');
    const message =
      `\n[Env Validation] Application startup aborted — ` +
      `${violations.length} environment variable problem(s) found:\n${lines}\n\n` +
      `Please review your .env file against .env.example and fix the issues above.\n`;

    if (process.env.NODE_ENV === 'test') {
      // In Jest we throw so assertions can catch the error message.
      throw new Error(message);
    }

    // In production / development we write to stderr and exit hard.
    process.stderr.write(message);
    process.exit(1);
  }

  return {
    DATABASE_URL,
    PORT,
    JSON_BODY_LIMIT_BYTES,
    MAINTENANCE_ADMIN_SECRET,
    CRON_SECRET,
    WALLET_ENCRYPTION_KEY,
    WALLET_ENCRYPTION_KEY_PREVIOUS,
    EXPORT_SIGNING_SECRET,
    STELLAR_HORIZON_URL,
    STELLAR_HORIZON_MAX_RETRIES,
    BALANCE_STALE_THRESHOLD_MS,
    BALANCE_SYNC_INTERVAL_MS,
    BALANCE_SYNC_MAX_RETRIES,
    CORS_ORIGINS,
    WEBHOOK_MAX_RETRIES,
    WEBHOOK_RETRY_BACKOFF_MS,
    WEBHOOK_TIMEOUT_MS,
    WEBHOOK_MAX_CONSECUTIVE_FAILURES,
    WEBHOOK_QUEUE_INTERVAL_MS,
    WEBHOOK_INBOUND_SECRET,
    AUTH_RATE_LIMIT_MAX,
    AUTH_RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_SENSITIVE_WINDOW_MS,
    RATE_LIMIT_SENSITIVE_MAX_REQUESTS,
    API_KEY_ROTATION_GRACE_SECONDS,
    KEY_MGMT_MAX_RETRIES,
    KEY_MGMT_RETRY_BACKOFF_MS,
    BLOCK_SELF_PAYMENTS,
    AUTH_IDENTITY_PROVIDER,
    CLERK_JWT_PUBLIC_KEY,
    BETTER_AUTH_JWKS_URL,
    OTEL_ENABLED,
    OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_PROTOCOL,
    OTEL_SERVICE_NAME,
  };
}
