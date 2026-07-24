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
  WALLET_ENCRYPTION_KEY: string;
  STELLAR_HORIZON_URL: string;
  BALANCE_STALE_THRESHOLD_MS: number;
  WEBHOOK_MAX_RETRIES: number;
  WEBHOOK_RETRY_BACKOFF_MS: number;
  WEBHOOK_TIMEOUT_MS: number;
  WEBHOOK_MAX_CONSECUTIVE_FAILURES: number;
  AUTH_RATE_LIMIT_MAX: number;
  AUTH_RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
  RATE_LIMIT_SENSITIVE_WINDOW_MS: number;
  RATE_LIMIT_SENSITIVE_MAX_REQUESTS: number;
  API_KEY_ROTATION_GRACE_SECONDS: number;
  KEY_MGMT_MAX_RETRIES: number;
  KEY_MGMT_RETRY_BACKOFF_MS: number;
}

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

function requireNonPlaceholder(
  env: NodeJS.ProcessEnv,
  key: string,
  placeholder: string,
  violations: EnvViolation[],
  existingVal?: string,
): string {
  const val = existingVal ?? env[key] ?? '';
  if (val === placeholder) {
    violations.push({
      variable: key,
      message: `${key} cannot use the default placeholder value "${placeholder}"`,
    });
  }
  return val;
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
  
  // Issue #491: Enhanced validation for WALLET_ENCRYPTION_KEY
  let WALLET_ENCRYPTION_KEY = requireMinLength(
    env,
    'WALLET_ENCRYPTION_KEY',
    32,
    violations,
  );
  
  // Ensure it's not using the default placeholder value
  WALLET_ENCRYPTION_KEY = requireNonPlaceholder(
    env,
    'WALLET_ENCRYPTION_KEY',
    'your-secret-encryption-key-min-32-chars',
    violations,
    WALLET_ENCRYPTION_KEY,
  );
  
  const STELLAR_HORIZON_URL = requireUrl(
    env,
    'STELLAR_HORIZON_URL',
    violations,
  );

  // ── Optional numeric fields ───────────────────────────────────────────────
  const PORT = optionalInt(env, 'PORT', 3000, { min: 1, max: 65535 }, violations);
  const BALANCE_STALE_THRESHOLD_MS = optionalInt(
    env,
    'BALANCE_STALE_THRESHOLD_MS',
    300_000,
    { min: 0 },
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
    WALLET_ENCRYPTION_KEY,
    STELLAR_HORIZON_URL,
    BALANCE_STALE_THRESHOLD_MS,
    WEBHOOK_MAX_RETRIES,
    WEBHOOK_RETRY_BACKOFF_MS,
    WEBHOOK_TIMEOUT_MS,
    WEBHOOK_MAX_CONSECUTIVE_FAILURES,
    AUTH_RATE_LIMIT_MAX,
    AUTH_RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_SENSITIVE_WINDOW_MS,
    RATE_LIMIT_SENSITIVE_MAX_REQUESTS,
    API_KEY_ROTATION_GRACE_SECONDS,
    KEY_MGMT_MAX_RETRIES,
    KEY_MGMT_RETRY_BACKOFF_MS,
  };
}
