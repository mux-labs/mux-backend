/**
 * Transient Prisma error codes that indicate a temporary connectivity issue.
 * P1001: Can't reach database
 * P1002: Database server timeout
 * P1008: Operations timed out
 * P1009: Database already exists
 * P1017: Server closed connection
 */
const TRANSIENT_PRISMA_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;

  if (typeof err.code === 'string' && TRANSIENT_PRISMA_CODES.has(err.code)) {
    return true;
  }

  const msg = typeof err.message === 'string' ? err.message : '';
  return (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async operation with exponential backoff on transient failures.
 *
 * @param operation  Async function to retry.
 * @param maxAttempts  Maximum number of attempts (default 3).
 * @param baseDelayMs  Initial delay in ms; doubles on each retry (default 100).
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 100,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isTransientError(error) || attempt === maxAttempts) {
        throw error;
      }

      const backoffMs = baseDelayMs * Math.pow(2, attempt - 1);
      await delay(backoffMs);
    }
  }

  // Unreachable — loop always throws on last attempt — but satisfies TypeScript.
  throw lastError;
}
