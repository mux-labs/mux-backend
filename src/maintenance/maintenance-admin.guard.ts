import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class MaintenanceAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configured = this.config.get<string>('MAINTENANCE_ADMIN_SECRET', '');
    const supplied = context
      .switchToHttp()
      .getRequest<Request>().headers['x-maintenance-secret'];

    if (
      !configured ||
      typeof supplied !== 'string' ||
      !this.secretsMatch(configured, supplied)
    ) {
      throw new UnauthorizedException(
        'A valid maintenance administrator secret is required',
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
