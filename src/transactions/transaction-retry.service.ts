import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TransactionRetryOptions {
  operation: string;
  /** Maximum number of attempts, including the first attempt. */
  maxAttempts?: number;
}

/**
 * Retries transient Stellar/Horizon network errors with capped exponential backoff.
 *
 * Only retries on transient failures (5xx, timeouts, connection errors).
 * Never retries on validation failures or Horizon rejection (4xx).
 */
@Injectable()
export class TransactionRetryService {
  private readonly logger = new Logger(TransactionRetryService.name);
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly configService: ConfigService) {
    this.maxAttempts = this.configService.get<number>(
      'TRANSACTION_RETRY_MAX_ATTEMPTS',
      3,
    );
    this.baseDelayMs = this.configService.get<number>(
      'TRANSACTION_RETRY_BASE_DELAY_MS',
      100,
    );
    this.maxDelayMs = this.configService.get<number>(
      'TRANSACTION_RETRY_MAX_DELAY_MS',
      2_000,
    );
  }

  async execute<T>(
    options: TransactionRetryOptions,
    operation: (attempt: number) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? this.maxAttempts);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt === maxAttempts || !this.isTransient(error)) {
          throw error;
        }

        const delayMs = Math.min(
          this.baseDelayMs * 2 ** (attempt - 1),
          this.maxDelayMs,
        );
        this.logger.warn(
          `Retrying transaction ${options.operation} (attempt ${attempt + 1}/${maxAttempts}) in ${delayMs}ms`,
        );
        await this.wait(delayMs);
      }
    }

    throw new Error(`Transaction ${options.operation} retry loop exhausted`);
  }

  private isTransient(error: unknown): boolean {
    const candidate = error as {
      code?: string;
      status?: number;
      response?: { status?: number };
      name?: string;
    };
    const status = candidate?.response?.status ?? candidate?.status;
    if (typeof status === 'number') {
      return (
        status === 408 || status === 425 || status === 429 || status >= 500
      );
    }

    if (candidate?.name === 'AbortError') return false;

    return new Set([
      'ECONNABORTED',
      'ECONNREFUSED',
      'ECONNRESET',
      'EAI_AGAIN',
      'ENETUNREACH',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
    ]).has(candidate?.code ?? '');
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
