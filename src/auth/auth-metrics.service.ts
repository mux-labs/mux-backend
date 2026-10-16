import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';

@Injectable()
export class AuthMetricsService {
  private readonly logger = new Logger(AuthMetricsService.name);

  constructor(private readonly metricsService: MetricsService) {}

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
    this.metricsService.incrementCounter('auth_attempts_total', {
      provider,
      outcome: 'success',
    });
  }

  recordFailure(provider: string, reason: string): void {
    this.logger.debug(`auth_failure provider=${provider} reason=${reason}`);
    this.metricsService.incrementCounter('auth_attempts_total', {
      provider,
      outcome: 'failure',
    });
  }
}
