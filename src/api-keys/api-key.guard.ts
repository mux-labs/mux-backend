import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from './api-key.service';
import {
  ApiKeyAuditAction,
  ApiKeyAuditReason,
  ApiKeyAuditService,
} from './api-key-audit.service';
import { resolveRequestId } from '../common/interceptors/request-id.interceptor';

export const REQUIRE_API_KEY = 'requireApiKey';
export const IS_PUBLIC = 'isPublic';

/**
 * Guard that validates API keys on incoming requests.
 *
 * Deny-by-default: if no valid API key is present, the request
 * is rejected with 401 Unauthorized.
 *
 * Routes can be marked public with the @Public() decorator,
 * which skips API key validation.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
    // Optional so the guard still constructs in modules that have not wired the
    // audit sink yet; when present, every auth decision is recorded.
    @Optional()
    private readonly audit?: ApiKeyAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization as string | undefined;
    const correlationId = resolveRequestId(
      request.requestId ?? request.headers?.['x-request-id'],
    );

    if (!authHeader) {
      this.auditDecision({
        action: ApiKeyAuditAction.REJECTED,
        reason: ApiKeyAuditReason.MISSING,
        apiKey: undefined,
        request,
        correlationId,
      });
      throw new UnauthorizedException('API key is required');
    }

    const apiKey = this.extractApiKey(authHeader);
    if (!apiKey) {
      this.auditDecision({
        action: ApiKeyAuditAction.REJECTED,
        reason: ApiKeyAuditReason.MALFORMED,
        apiKey: undefined,
        request,
        correlationId,
      });
      throw new UnauthorizedException('Invalid API key format');
    }

    let validation;
    try {
      validation = await this.apiKeyService.validateApiKey(apiKey);
    } catch (err) {
      // Dependency outage (DB/Horizon) fails closed: the request is refused and
      // the outage is audited, so an unavailable key store is visible to an
      // operator instead of looking like a burst of bad credentials.
      this.auditDecision({
        action: ApiKeyAuditAction.VALIDATION_UNAVAILABLE,
        reason: ApiKeyAuditReason.UNKNOWN,
        apiKey,
        request,
        correlationId,
      });
      throw err instanceof UnauthorizedException
        ? err
        : new ServiceUnavailableException(
            'API key validation service unavailable',
          );
    }

    if (!validation) {
      this.auditDecision({
        action: ApiKeyAuditAction.REJECTED,
        reason: ApiKeyAuditReason.UNKNOWN,
        apiKey,
        request,
        correlationId,
      });
      throw new UnauthorizedException('Invalid API key');
    }

    request.apiKey = validation;
    this.auditDecision({
      action: ApiKeyAuditAction.VALIDATED,
      apiKey,
      request,
      correlationId,
      apiKeyId: validation.apiKey?.id,
      developerId: validation.developer?.id,
      projectId: validation.project?.id,
    });
    return true;
  }

  /**
   * Records one authentication decision in the audit trail.
   *
   * Never throws and never re-throws: an audit-sink problem must not change the
   * authentication outcome, and it must not leak the presented key into an
   * error. The fingerprint is derived from the key, never the key itself.
   */
  private auditDecision(input: {
    action: ApiKeyAuditAction;
    reason?: ApiKeyAuditReason;
    apiKey?: string;
    request: {
      method?: string;
      path?: string;
      originalUrl?: string;
      ip?: string;
      socket?: { remoteAddress?: string };
    };
    correlationId: string;
    apiKeyId?: string;
    developerId?: string;
    projectId?: string;
  }): void {
    if (!this.audit) {
      return;
    }
    try {
      const path = (
        input.request.path ??
        input.request.originalUrl ??
        ''
      ).split('?')[0];
      this.audit.record({
        action: input.action,
        reason: input.reason,
        fingerprint: this.audit.fingerprint(input.apiKey),
        apiKeyId: input.apiKeyId,
        developerId: input.developerId,
        projectId: input.projectId,
        route: `${input.request.method ?? 'UNKNOWN'} ${path}`,
        ip: input.request.ip ?? input.request.socket?.remoteAddress,
        correlationId: input.correlationId,
      });
    } catch {
      // Fail-soft: the request path must not depend on the audit sink.
    }
  }

  private extractApiKey(header: string): string | null {
    if (header.startsWith('Bearer ')) {
      return header.slice(7);
    }
    if (header.startsWith('ApiKey ')) {
      return header.slice(7);
    }
    return null;
  }
}
