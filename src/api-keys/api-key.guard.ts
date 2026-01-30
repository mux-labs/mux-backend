import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
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
 * Guard that validates API key authentication
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route requires API key
    const requireApiKey = this.reflector.get<boolean>(
      REQUIRE_API_KEY,
      context.getHandler(),
    );

    if (!requireApiKey) {
      return true; // Route doesn't require API key
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

      // Record usage (async, don't await)
      const responseTime = Date.now() - startTime;
      this.apiKeyService
        .recordUsage(
          apiKeyContext.apiKey.id,
          apiKeyContext.project.id,
          request.path,
          request.method,
          undefined, // Status code not available yet
          request.ip,
          request.headers['user-agent'],
          responseTime,
        )
        .catch((err) => this.logger.error('Failed to record usage:', err));

      return true;
    } catch (error) {
      this.logger.warn(`API key validation failed: ${error.message}`);
      throw new UnauthorizedException(error.message || 'Invalid API key');
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
