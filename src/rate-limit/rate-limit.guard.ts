import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitService } from './rate-limit.service';
import { ApiKeyInfo } from '../auth/api-key.service';

export const IS_SENSITIVE_ENDPOINT = 'isSensitiveEndpoint';
export const SensitiveEndpoint = () => SetMetadata(IS_SENSITIVE_ENDPOINT, true);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly rateLimitService: RateLimitService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKeyInfo: ApiKeyInfo | undefined = request.apiKeyInfo;

    // If no API key info, skip rate limiting (public endpoint or not authenticated)
    if (!apiKeyInfo) {
      return true;
    }

    // Get endpoint path
    const endpoint = this.getEndpointPath(request);

    // Check if this is a sensitive endpoint
    const isSensitive =
      this.reflector.getAllAndOverride<boolean>(IS_SENSITIVE_ENDPOINT, [
        context.getHandler(),
        context.getClass(),
      ]) || false;

    // Check rate limit
    const result = await this.rateLimitService.checkRateLimit(
      apiKeyInfo.id,
      endpoint,
      isSensitive,
    );

    // Set rate limit headers
    const response = context.switchToHttp().getResponse();
    response.setHeader('X-RateLimit-Limit', result.limit);
    response.setHeader('X-RateLimit-Remaining', result.remaining);
    response.setHeader(
      'X-RateLimit-Reset',
      Math.ceil(result.resetTime.getTime() / 1000),
    );

    if (!result.allowed) {
      this.logger.warn(
        `Rate limit exceeded for API key ${apiKeyInfo.id} on ${endpoint}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(
            (result.resetTime.getTime() - Date.now()) / 1000,
          ),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Gets a normalized endpoint path for rate limiting
   */
  private getEndpointPath(request: any): string {
    // Use the route path instead of full URL for better grouping
    const route = request.route?.path || request.path;
    const method = request.method?.toUpperCase() || 'UNKNOWN';

    // Normalize path (remove IDs for better grouping)
    // e.g., /wallets/123 -> /wallets/:id
    const normalizedPath = route
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-f0-9-]{36}/gi, '/:id') // UUIDs
      .replace(/\/[a-f0-9-]{32}/gi, '/:id'); // Hashes

    return `${method} ${normalizedPath}`;
  }
}
