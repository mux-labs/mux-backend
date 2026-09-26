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
import { ApiKeyErrorCode } from './domain/api-key.model';
import {
  assertNetworkMatch,
  extractRequestedNetwork,
} from '../common/network/network-mismatch';

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
    const authHeader = request.headers?.authorization as string | undefined;

    if (!authHeader) {
      throw new UnauthorizedException({
        code: ApiKeyErrorCode.UNAUTHORIZED,
        message: 'API key is required',
      });
    }

    const apiKey = this.extractApiKey(authHeader);
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
