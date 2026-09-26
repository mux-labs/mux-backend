/**
 * Validates required environment variables at startup.
 * Fail-fast: throws if any required variable is missing or invalid.
 */

export interface ValidatedEnv {
  PORT: number;
  DATABASE_URL: string;
  STELLAR_NETWORK: 'mainnet' | 'testnet';
  JSON_BODY_LIMIT_BYTES: number;
  CORS_ORIGINS: string;
  MAINNET_PAYMENT_ENABLED: string;
  NODE_ENV: string;
  LOG_LEVEL: string;
}

const REQUIRED_VARS = [
  'DATABASE_URL',
  'STELLAR_NETWORK',
] as const;

const DEFAULTS = {
  PORT: 3000,
  JSON_BODY_LIMIT_BYTES: 1024 * 1024, // 1MB
  CORS_ORIGINS: 'http://localhost:3000',
  MAINNET_PAYMENT_ENABLED: 'false',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
} as const;

/**
 * Validates and returns typed environment configuration.
 * Throws on missing required variables.
 */
export function validateEnv(env: NodeJS.ProcessEnv): ValidatedEnv {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  const stellarNetwork = env.STELLAR_NETWORK?.toLowerCase();
  if (stellarNetwork !== 'mainnet' && stellarNetwork !== 'testnet') {
    throw new Error(
      `STELLAR_NETWORK must be 'mainnet' or 'testnet', got: ${stellarNetwork}`,
    );
  }

  return {
    PORT: parseInt(env.PORT || DEFAULTS.PORT.toString(), 10),
    DATABASE_URL: env.DATABASE_URL!,
    STELLAR_NETWORK: stellarNetwork as 'mainnet' | 'testnet',
    JSON_BODY_LIMIT_BYTES: parseInt(
      env.JSON_BODY_LIMIT_BYTES || DEFAULTS.JSON_BODY_LIMIT_BYTES.toString(),
      10,
    ),
    CORS_ORIGINS: env.CORS_ORIGINS || DEFAULTS.CORS_ORIGINS,
    MAINNET_PAYMENT_ENABLED: env.MAINNET_PAYMENT_ENABLED || DEFAULTS.MAINNET_PAYMENT_ENABLED,
    NODE_ENV: env.NODE_ENV || DEFAULTS.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL || DEFAULTS.LOG_LEVEL,
  };
}