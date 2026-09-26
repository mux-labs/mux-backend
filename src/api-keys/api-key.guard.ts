import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from './api-key.service';
import { IS_PUBLIC_KEY, REQUIRE_API_KEY_KEY } from './api-key.decorator';

/**
 * Guard that validates API keys for protected routes.
 * Public routes (marked with @Public()) bypass this guard.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
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

    let apiKey: string | undefined;

    if (authorization?.startsWith('ApiKey ')) {
      apiKey = authorization.slice(7).trim();
    } else if (apiKeyHeader) {
      apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    }

    if (!apiKey) {
      if (requireApiKey === false) {
        return true;
      }
      throw new UnauthorizedException('API key required');
    }

    try {
      const validation = await this.apiKeyService.validateApiKey(apiKey);
      
      // Attach context to request for downstream use
      request.apiKeyContext = {
        apiKeyId: validation.apiKey.id,
        projectId: validation.project.id,
        developerId: validation.developer.id,
        rateLimitRpm: validation.project.rateLimitRpm,
      };
      
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error('API key validation error', error);
      throw new ServiceUnavailableException('API key validation service unavailable');
    }
  }
}