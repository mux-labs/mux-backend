import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AuthMetricsService {
  private readonly logger = new Logger(AuthMetricsService.name);

  recordAttempt(success: boolean, provider: string): void {
    this.logger.debug(`auth_attempt provider=${provider} success=${success}`);
  }

  recordSuccess(provider: string): void {
    this.logger.debug(`auth_success provider=${provider}`);
  }

  recordFailure(provider: string, reason: string): void {
    this.logger.debug(`auth_failure provider=${provider} reason=${reason}`);
  }
}
