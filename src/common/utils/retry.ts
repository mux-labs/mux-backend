import { Logger } from '@nestjs/common';

export class RetryError extends Error {
  constructor(
    public readonly lastError: Error,
    public readonly attemptsMade: number,
  ) {
    super(
      `Retryable operation failed after ${attemptsMade} attempts: ${lastError.message}`,
    );
    this.name = 'RetryError';
  }
}

function isRetryable(error: any): boolean {
  if (!error) return false;

  // Don't retry on client errors (4xx)
  if (error.status && error.status >= 400 && error.status < 500) {
    return false;
  }

  // Retry on network errors, timeouts, server errors (5xx), or other thrown exceptions
  return true;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 100,
  logger?: Logger,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts || !isRetryable(error)) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger?.debug(
        `Retry attempt ${attempt} failed: ${lastError.message}. Waiting ${delay}ms before retry.`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but for type safety
  throw lastError || new Error('Unknown retry error');
}
