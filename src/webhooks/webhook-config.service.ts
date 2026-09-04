import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Validates webhook environment variables on application startup
 */
@Injectable()
export class WebhookConfigService implements OnModuleInit {
  private readonly logger = new Logger(WebhookConfigService.name);

  private readonly requiredEnvVars = [
    'WEBHOOK_MAX_RETRIES',
    'WEBHOOK_RETRY_BACKOFF_MS',
    'WEBHOOK_TIMEOUT_MS',
    'WEBHOOK_MAX_CONSECUTIVE_FAILURES',
  ];

  constructor(private readonly configService: ConfigService) {}

  /**
   * Validates all required webhook environment variables on module initialization
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Validating webhook environment variables...');

    const missingVars: string[] = [];

    for (const envVar of this.requiredEnvVars) {
      const value = this.configService.get<string>(envVar);

      if (value === undefined || value === null || value === '') {
        missingVars.push(envVar);
      }
    }

    if (missingVars.length > 0) {
      const errorMessage = `Missing required webhook environment variables: ${missingVars.join(', ')}. Set them in .env before starting the server.`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    // Validate types
    const maxRetries = this.configService.get<number>('WEBHOOK_MAX_RETRIES');
    const retryBackoffMs = this.configService.get<number>(
      'WEBHOOK_RETRY_BACKOFF_MS',
    );
    const timeoutMs = this.configService.get<number>('WEBHOOK_TIMEOUT_MS');
    const maxConsecutiveFailures = this.configService.get<number>(
      'WEBHOOK_MAX_CONSECUTIVE_FAILURES',
    );

    if (typeof maxRetries !== 'number' || maxRetries < 0) {
      throw new Error(
        'WEBHOOK_MAX_RETRIES must be a non-negative number',
      );
    }

    if (typeof retryBackoffMs !== 'number' || retryBackoffMs < 0) {
      throw new Error(
        'WEBHOOK_RETRY_BACKOFF_MS must be a non-negative number',
      );
    }

    if (typeof timeoutMs !== 'number' || timeoutMs < 0) {
      throw new Error('WEBHOOK_TIMEOUT_MS must be a non-negative number');
    }

    if (
      typeof maxConsecutiveFailures !== 'number' ||
      maxConsecutiveFailures < 0
    ) {
      throw new Error(
        'WEBHOOK_MAX_CONSECUTIVE_FAILURES must be a non-negative number',
      );
    }

    this.logger.log('✅ Webhook environment variables validated successfully');
  }
}
