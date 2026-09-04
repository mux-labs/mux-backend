import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/** Header carrying the shared internal-service credential. */
export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

/** Config/environment key holding the expected internal-service credential. */
export const INTERNAL_API_KEY_ENV = 'KEY_MANAGEMENT_INTERNAL_API_KEY';

/**
 * Guard that restricts key-management routes to trusted internal callers
 * (issue #690).
 *
 * `FeatureFlagGuard` only gates *whether* the API is on — it is not an
 * authorization boundary. These endpoints custody Stellar private keys, so they
 * additionally require a shared secret supplied in the `x-internal-api-key`
 * header and compared against `KEY_MANAGEMENT_INTERNAL_API_KEY`.
 *
 * Fail-closed semantics (mirrors `CronSecretGuard`):
 *  - Secret not configured  → every request is denied (503). There is no
 *    implicit "allow" path and no default credential.
 *  - Header missing/blank    → 401.
 *  - Header does not match   → 401 (constant-time comparison).
 *
 * These application-layer checks complement — they do not replace — network
 * policy / service-mesh restrictions that should also front the controller.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  private readonly logger = new Logger(InternalServiceGuard.name);
  private readonly expectedKey: string;

  constructor(configService: ConfigService) {
    this.expectedKey = (
      configService.get<string>(INTERNAL_API_KEY_ENV, '') ?? ''
    ).trim();
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? 'unknown';

    if (!this.expectedKey) {
      this.logger.error(
        `${INTERNAL_API_KEY_ENV} is not configured — denying all key-management ` +
          `requests (req=${requestId})`,
      );
      throw new ServiceUnavailableException(
        'Internal key-management API is not configured on this server',
      );
    }

    const provided = this.readHeader(request);

    if (!provided) {
      this.logger.warn(
        `Key-management request missing ${INTERNAL_API_KEY_HEADER} header ` +
          `(req=${requestId}, ip=${request.ip})`,
      );
      throw new UnauthorizedException(
        `${INTERNAL_API_KEY_HEADER} header is required`,
      );
    }

    if (!this.matches(provided)) {
      this.logger.warn(
        `Key-management request with invalid internal API key ` +
          `(req=${requestId}, ip=${request.ip})`,
      );
      throw new UnauthorizedException('Invalid internal API key');
    }

    return true;
  }

  private readHeader(request: Request): string {
    const raw = request.headers[INTERNAL_API_KEY_HEADER];
    if (Array.isArray(raw)) return (raw[0] ?? '').trim();
    return (raw ?? '').trim();
  }

  private matches(provided: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(this.expectedKey);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
