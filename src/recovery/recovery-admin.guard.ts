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
export class RecoveryAdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const configured = this.config.get<string>('RECOVERY_ADMIN_SECRET', '')?.trim();
    const supplied = request.headers['x-recovery-admin-secret'];
    const devBypass = this.config.get<string>('RECOVERY_ADMIN_DEV_BYPASS', 'false') === 'true';

    if (process.env.NODE_ENV !== 'production' && devBypass && supplied === 'dev-recovery-admin') {
      (request as any).recoveryAdminId = request.headers['x-admin-id'] ?? 'local-admin';
      return true;
    }

    if (!configured || typeof supplied !== 'string' || !this.secretsMatch(configured, supplied)) {
      throw new UnauthorizedException('A valid recovery administrator secret is required');
    }
    const adminId = request.headers['x-admin-id'];
    if (typeof adminId !== 'string' || !adminId.trim()) {
      throw new UnauthorizedException('X-Admin-ID is required');
    }
    (request as any).recoveryAdminId = adminId.trim();
    return true;
  }

  private secretsMatch(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  }
}