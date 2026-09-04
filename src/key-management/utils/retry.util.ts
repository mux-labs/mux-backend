export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Executes fn with exponential backoff. Non-retryable errors are rethrown
 * immediately without consuming remaining attempts.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs = 30_000,
    backoffFactor = 2,
    shouldRetry = () => true,
  } = options;

  let attempt = 0;
  let delayMs = initialDelayMs;

  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
    }
  }
}
