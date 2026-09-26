import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AuthMetricsService {
  private readonly logger = new Logger(AuthMetricsService.name);

  recordAttempt(
    successOrOutcome: boolean | string,
    providerOrLatency: string | number,
  ): void {
    if (typeof successOrOutcome === 'string') {
      this.logger.debug(
        `auth_attempt outcome=${successOrOutcome} latency=${providerOrLatency}ms`,
      );
    } else {
      this.logger.debug(
        `auth_attempt provider=${providerOrLatency} success=${successOrOutcome}`,
      );
    }
  }

  recordSuccess(provider: string): void {
    this.logger.debug(`auth_success provider=${provider}`);
  }

  recordFailure(provider: string, reason: string): void {
    this.logger.debug(`auth_failure provider=${provider} reason=${reason}`);
  }
}
