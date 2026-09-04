import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/** Header carrying the shared cron/internal-endpoint credential. */
export const CRON_SECRET_HEADER = 'x-cron-secret';

/** Config/environment key holding the expected cron credential. */
export const CRON_SECRET_ENV = 'CRON_SECRET';

/**
 * Guard that validates cron/internal endpoint requests using a shared secret
 * header (issue #801).
 *
 * These endpoints (e.g. `POST /transactions/internal/poll-pending`) bypass
 * normal project API-key scoping and operate with elevated, cross-tenant
 * privileges, so they require a shared secret supplied in the
 * `X-Cron-Secret` header and compared against the configured `CRON_SECRET`
 * environment variable.
 *
 * Fail-closed semantics (mirrors `InternalServiceGuard`):
 *  - Secret not configured  → every request is denied (401). There is no
 *    implicit "allow" path and no default/mock credential, in any
 *    environment (`env.validation.ts` additionally fails application startup
 *    if `CRON_SECRET` is unset or too short in production).
 *  - Header missing/blank    → 401.
 *  - Header does not match   → 401 (constant-time comparison, so a caller
 *    cannot use response timing to learn the secret byte-by-byte).
 *
 * These application-layer checks complement — they do not replace — network
 * policy / mTLS restrictions that should also front internal endpoints.
 */
@Injectable()
export class CronSecretGuard implements CanActivate {
  private readonly logger = new Logger(CronSecretGuard.name);
  private readonly cronSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.cronSecret = (
      this.configService.get<string>(CRON_SECRET_ENV, '') ?? ''
    ).trim();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? 'unknown';

    if (!this.cronSecret) {
      this.logger.warn(
        `CRON_SECRET not configured; denying all cron requests ` +
          `(req=${requestId}, path=${request.path})`,
      );
      throw new UnauthorizedException('Cron secret not configured on server');
    }

    const provided = this.readHeader(request);

    if (!provided) {
      this.logger.warn(
        `Cron request missing ${CRON_SECRET_HEADER} header ` +
          `(req=${requestId}, path=${request.path}, ip=${request.ip})`,
      );
      throw new UnauthorizedException(
        `${CRON_SECRET_HEADER} header is required`,
      );
    }

    if (!this.matches(provided)) {
      this.logger.warn(
        `Cron request with invalid secret ` +
          `(req=${requestId}, path=${request.path}, ip=${request.ip})`,
      );
      throw new UnauthorizedException('Invalid cron secret');
    }

    this.logger.debug(
      `[${requestId}] Cron request from ${request.ip} authenticated successfully`,
    );
    return true;
  }

  private readHeader(request: Request): string {
    const raw = request.headers[CRON_SECRET_HEADER];
    if (Array.isArray(raw)) return (raw[0] ?? '').trim();
    return (raw ?? '').trim();
  }

  /** Constant-time comparison so response timing can't leak the secret. */
  private matches(provided: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(this.cronSecret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
