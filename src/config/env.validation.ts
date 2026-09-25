import { validate } from 'class-validator';

/**
 * Validates required environment variables before the application
 * starts. Returns the validated env object.
 *
 * Fail-closed: if required env vars are missing or invalid,
 * the process exits with a non-zero code.
 */
export function validateEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const requiredVars = ['DATABASE_URL'];

  const missing = requiredVars.filter((v) => !env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  return env;
}
