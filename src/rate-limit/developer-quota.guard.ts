import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import {
  DeveloperQuotaErrorCode,
  RateLimitService,
} from './rate-limit.service';

/** The request shape the guard reads. */
interface QuotaRequest {
  apiKey?: { developer?: { id?: unknown } };
  set?: (name: string, value: string) => void;
}

/**
 * DeveloperQuotaGuard
 *
 * Enforces the per-developer request quota, in addition to the per-API-key limit.
 *
 * Invariants:
 *
 * 1. **Keyed on the server-resolved developer.** The id comes from the API key
 *    the server already validated, never from a body or query parameter. A client
 *    that sends its own `developerId` cannot borrow another developer's quota or
 *    escape its own.
 * 2. **Deny-by-default, and inert when disabled.** With `DEVELOPER_QUOTAS_ENABLED`
 *    unset or not `true`, the guard admits everything without counting, so a
 *    deployment that has not opted in behaves exactly as before.
 * 3. **Fails closed on an unattributed request.** If quotas are on and the
 *    request has no resolved developer, it is refused. An unaccounted request
 *    cannot be proven to be within any quota.
 * 4. **Actionable, non-leaking 429.** The response carries the stable
 *    `DEVELOPER_QUOTA_EXCEEDED` code plus `Retry-After` and the standard
 *    `X-RateLimit-*` headers. It never echoes a key, an email, or a body.
 * 5. **Ordering.** The guard is designed to run *after* authentication, so the
 *    developer is known and an unauthenticated flood is rejected as `401` before
 *    it can consume any developer's quota.
 */
@Injectable()
export class DeveloperQuotaGuard implements CanActivate {
  constructor(private readonly rateLimitService: RateLimitService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.rateLimitService.isQuotaEnabled()) {
      return true;
    }

    const request = context.switchToHttp().getRequest<QuotaRequest>();
    const developerId = this.resolveDeveloperId(request);
    const decision = this.rateLimitService.consume(developerId);

    if (decision.allowed) {
      this.setRateLimitHeaders(request, decision.limitRpm, decision.remaining);
      return true;
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((decision.resetAt - Date.now()) / 1000),
    );
    this.setRateLimitHeaders(request, decision.limitRpm, 0);
    this.setHeader(request, 'Retry-After', String(retryAfterSeconds));

    throw new HttpException(
      {
        errorCode: DeveloperQuotaErrorCode.EXCEEDED,
        message: 'Developer quota exceeded. Please try again later.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Resolves the developer from the authenticated API key context.
   *
   * Deliberately reads only `request.apiKey.developer.id`. Falling back to a
   * client-supplied `developerId` — even "only if the key is missing" — would
   * hand an attacker a way to spend another tenant's quota.
   */
  private resolveDeveloperId(request: QuotaRequest): string {
    const id = request.apiKey?.developer?.id;
    return typeof id === 'string' ? id : '';
  }

  private setRateLimitHeaders(
    request: QuotaRequest,
    limitRpm: number,
    remaining: number,
  ): void {
    this.setHeader(request, 'X-RateLimit-Limit', String(limitRpm));
    this.setHeader(
      request,
      'X-RateLimit-Remaining',
      String(Number.isFinite(remaining) ? remaining : limitRpm),
    );
  }

  private setHeader(request: QuotaRequest, name: string, value: string): void {
    if (typeof request.set === 'function') {
      request.set(name, value);
    }
  }
}
