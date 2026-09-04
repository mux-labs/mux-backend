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
 * Requires a shared secret (X-Horizon-Import-Secret) to trigger a Horizon
 * history import, on top of the standard API key auth. Prevents any valid
 * API key from kicking off expensive Horizon backfills; intended for
 * cron/ops callers.
 */
@Injectable()
export class HorizonImportGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configured = this.config.get<string>('HORIZON_IMPORT_SECRET', '');

    if (!configured) {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException(
          'HORIZON_IMPORT_SECRET must be configured to trigger Horizon history imports in production',
        );
      }
      return true;
    }

    const supplied = context.switchToHttp().getRequest<Request>().headers[
      'x-horizon-import-secret'
    ];

    if (
      typeof supplied !== 'string' ||
      !this.secretsMatch(configured, supplied)
    ) {
      throw new UnauthorizedException(
        'A valid Horizon import secret is required',
      );
    }

    return true;
  }

  private secretsMatch(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }
}
