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
import { Request } from 'express';

/**
 * Metadata key for marking routes as requiring API key auth
 */
export const REQUIRE_API_KEY = 'requireApiKey';

/**
 * Metadata key for marking routes as public (no auth required)
 */
export const IS_PUBLIC = 'isPublic';

/**
 * Guard that validates API key authentication
 * Supports both local (REQUIRE_API_KEY) and global usage (IS_PUBLIC)
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public (skip auth)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Check if route requires API key (for explicit opt-in)
    const requireApiKey = this.reflector.get<boolean>(
      REQUIRE_API_KEY,
      context.getHandler(),
    );

    if (requireApiKey === false) {
      return true; // Route explicitly doesn't require API key
    }

    const request = context.switchToHttp().getRequest<Request>();
    const startTime = Date.now();

    try {
      // Extract API key from Authorization header
      const apiKey = this.extractApiKey(request);

      if (!apiKey) {
        throw new UnauthorizedException('API key is required');
      }

      // Validate API key
      const apiKeyContext = await this.apiKeyService.validateApiKey(apiKey);

      // Attach context to request for use in controllers
      (request as any).apiKeyContext = apiKeyContext;

      // Also set apiKeyInfo for backward compatibility with rate limiting
      (request as any).apiKeyInfo = {
        id: apiKeyContext.apiKey.id,
        project: {
          rateLimitRpm: apiKeyContext.project.rateLimitRpm,
        },
      };

      // Record usage after response completes to capture final status code and latency
      const requestStart = Date.now();
      const response = context.switchToHttp().getResponse();

      if (response && typeof response.on === 'function') {
        response.on('finish', () => {
          const responseTime = Date.now() - requestStart;
          const endpoint = `${request.method} ${request.path}`;
          const statusCode = response.statusCode || 0;
          const ipAddress =
            (request.headers['x-forwarded-for'] as string | undefined)
              ?.split(',')[0]
              .trim() ||
            request.ip ||
            request.socket?.remoteAddress ||
            'unknown';

          this.apiKeyService.recordUsage(
            apiKeyContext.apiKey.id,
            apiKeyContext.project.id,
            endpoint,
            request.method,
            statusCode,
            ipAddress,
            request.headers['user-agent'],
            responseTime,
          );
        });
      }

      return true;
    } catch (error) {
      this.logger.warn(`API key validation failed: ${error?.message}`);
      // If the service threw an UnauthorizedException, preserve it (invalid key)
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      // Treat other errors as upstream/service issues (map to 503)
      throw new ServiceUnavailableException(
        'API key validation service unavailable',
      );
    }
  }

  /**
   * Extracts API key from Authorization header
   * Supports: "Bearer mux_live_..." or "ApiKey mux_live_..."
   */
  private extractApiKey(request: Request): string | null {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      return null;
    }

    // Support "Bearer mux_..." or "ApiKey mux_..."
    const parts = authHeader.split(' ');

    if (parts.length !== 2) {
      return null;
    }

    const [scheme, token] = parts;

    if (scheme !== 'Bearer' && scheme !== 'ApiKey') {
      return null;
    }

    return token;
  }
}
