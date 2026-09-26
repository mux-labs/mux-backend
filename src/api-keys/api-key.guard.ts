import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  Logger,
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
import { ApiKeyErrorCode } from './domain/api-key.model';
import { IS_PUBLIC_KEY, REQUIRE_API_KEY_KEY } from './api
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from './api-key.service';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Optional,
  HttpException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from './api-key.service';


export const REQUIRE_API_KEY = 'requireApiKey';
export const IS_PUBLIC = 'isPublic';

/**
 * Guard that validates API keys on incoming requests.
 *
 * Invariants:
 * - **Deny-by-default.** Only routes explicitly marked with `@Public()` skip
 *   authentication. Anything else without a valid key is rejected.
 * - **Revocation is immediate.** Validation delegates to `ApiKeyService`, which
 *   reads the authoritative row on every request, so a key revoked a moment ago
 *   is refused now (#942).
 * - **Network-scoped.** A key scoped to TESTNET/MAINNET may only be used for
 *   requests targeting that network; a mismatch is refused with the stable
 *   `NETWORK_MISMATCH` code *before* the handler runs (#943).
 * - **Fail-closed on dependency outage.** An unexpected validation failure is
 *   surfaced as 503 rather than being treated as "no key" (401) or allowed.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
    // Optional so the guard still constructs in modules that have not wired the
    // audit sink yet; when present, every auth decision is recorded.
    @Optional()
    private readonly audit?: ApiKeyAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Check if route explicitly requires API key (default behavior)
    const requireApiKey = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_API_KEY_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    const apiKeyHeader = request.headers?.['x-api-key'];
    const correlationId = resolveRequestId(
      request.requestId ?? request.headers?.['x-request-id'],
    );

    let apiKey: string | undefined;

    if (authorization?.startsWith('ApiKey ')) {
      apiKey = authorization.slice(7).trim();
    } else if (apiKeyHeader) {
      apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    }

    if (!apiKey) {
      this.auditDecision({
        action: ApiKeyAuditAction.REJECTED,
        reason: ApiKeyAuditReason.MISSING,
        apiKey: undefined,
        request,
        correlationId,
      });
      throw new UnauthorizedException('API key is required');
    }
    }

    if (!apiKey) {
      throw new UnauthorizedException({
        code: ApiKeyErrorCode.UNAUTHORIZED,
        message: 'API key is required',
      });
    }

    if (!apiKey) {
      throw new UnauthorizedException({
        code: ApiKeyErrorCode.INVALID_FORMAT,
        message: 'Invalid API key format',
      });
    }

    const startedAt = Date.now();
    let validation;

    try {
      validation = await this.apiKeyService.validateApiKey(apiKey);
    } catch (error) {
      // An HttpException from the service is a deliberate, typed decision
      // (401 revoked/expired, 403 forbidden, 503 store outage): pass it on.
      if (error instanceof HttpException) {
        throw error;
      }
      // Anything else is an unexpected dependency failure. Fail closed with a
      // retryable 503 rather than guessing at an identity.
      this.logger.error(
        `API key validation failed unexpectedly: ${(error as Error)?.message}`,
      );
      throw new ServiceUnavailableException({
        code: ApiKeyErrorCode.STORE_UNAVAILABLE,
        message: 'API key validation service unavailable',
      });
    }

    if (!validation) {
      throw new UnauthorizedException({
        code: ApiKeyErrorCode.INVALID,
        message: 'Invalid API key',
      });
    }

    // #943: refuse before the handler runs when the key cannot act on the
    // requested network.
    assertNetworkMatch({
      scope: validation.apiKey?.network ?? null,
      requested: extractRequestedNetwork(request),
      correlationId: request.headers?.['x-request-id'] as string | undefined,
      subject: 'api-key',
    });

    this.attachContext(
      request,
      validation,
      startedAt,
      context.switchToHttp().getResponse?.() ?? request.res,
    );
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

  /**
   * Attaches the authenticated identity to the request.
   *
   * `request.apiKey` is the raw validation result (used by handlers that need
   * the full project/developer); `request.apiKeyContext` is the flattened,
   * ops-safe view and `request.apiKeyInfo` the billing/rate-limit view. The
   * developer identity always comes from the key, never from the request body,
   * so a client cannot assert someone else's identity.
   */
  private attachContext(
    request: any,
    validation: any,
    startedAt: number,
    response?: any,
  ): void {
    request.apiKey = validation;
    request.apiKeyContext = {
      apiKeyId: validation.apiKey?.id,
      projectId: validation.project?.id,
      developerId: validation.developer?.id,
      apiKey: validation.apiKey,
      project: validation.project,
      developer: validation.developer,
    };
    request.apiKeyInfo = {
      id: validation.apiKey?.id,
      project: {
        rateLimitRpm: validation.project?.rateLimitRpm,
      },
    };

    // Record usage when the response finishes so the recorded status code and
    // duration are the real ones. Best-effort only — never block the request.
    if (response && typeof response.on === 'function') {
      response.on('finish', () => {
        void this.apiKeyService.recordUsage(
          validation.apiKey?.id,
          validation.project?.id,
          `${request.method ?? 'GET'} ${request.path ?? ''}`,
          request.method ?? 'GET',
          response.statusCode ?? 200,
          request.ip ?? request.socket?.remoteAddress,
          request.headers?.['user-agent'],
          Date.now() - startedAt,
        );
      });
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
