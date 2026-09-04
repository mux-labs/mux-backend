import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Guards the Prometheus scrape endpoint with a shared secret instead of the
 * standard API key auth, so scrapers don't need a provisioned API key.
 */
@Injectable()
export class MetricsGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configured = this.config.get<string>('METRICS_SCRAPE_TOKEN', '');

    if (!configured) {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException(
          'METRICS_SCRAPE_TOKEN must be configured to expose /v1/metrics in production',
        );
      }
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const supplied =
      request.headers['x-metrics-token'] ??
      request.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (
      typeof supplied !== 'string' ||
      !this.tokensMatch(configured, supplied)
    ) {
      throw new UnauthorizedException(
        'A valid metrics scrape token is required',
      );
    }

    return true;
  }

  private tokensMatch(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }
}
