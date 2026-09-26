import {
  Injectable,
  CanActivate,
  ExecutionContext,
  TooManyRequestsException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Rate limiting guard using sliding window algorithm.
 * Checks rate limits per API key and endpoint.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    
    // Get rate limit info from apiKeyContext (set by ApiKeyGuard)
    const apiKeyContext = request.apiKeyContext;
    
    if (!apiKeyContext) {
      // No API key context - either public route or auth failed
      // Let it through (auth will handle if needed)
      return true;
    }

    const { apiKeyId, projectId, rateLimitRpm } = apiKeyContext;
    const endpoint = request.route?.path || request.url || 'unknown';
    const windowStart = this.getWindowStart();
    const windowEnd = new Date(windowStart.getTime() + 60000); // 1 minute window

    try {
      // Use upsert to atomically increment counter
      const record = await this.prisma.rateLimitRecord.upsert({
        where: {
          apiKeyId_endpoint_windowStart: {
            apiKeyId,
            endpoint,
            windowStart,
          },
        },
        create: {
          apiKeyId,
          endpoint,
          windowStart,
          requestCount: 1,
        },
        update: {
          requestCount: { increment: 1 },
        },
      });

      const remaining = Math.max(0, rateLimitRpm - record.requestCount);
      const resetTime = Math.ceil(windowEnd.getTime() / 1000);

      // Set rate limit headers
      response.setHeader('X-RateLimit-Limit', rateLimitRpm);
      response.setHeader('X-RateLimit-Remaining', remaining);
      response.setHeader('X-RateLimit-Reset', resetTime);

      if (record.requestCount > rateLimitRpm) {
        this.logger.warn(
          `Rate limit exceeded for apiKey ${apiKeyId} on ${endpoint}: ${record.requestCount}/${rateLimitRpm}`,
        );
        
        const retryAfter = Math.ceil((windowEnd.getTime() - Date.now()) / 1000);
        response.setHeader('Retry-After', retryAfter);
        
        throw new TooManyRequestsException({
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests',
          retryAfter,
        });
      }

      return true;
    } catch (error) {
      if (error instanceof TooManyRequestsException) {
        throw error;
      }
      this.logger.error('Rate limit check failed', error);
      // Fail open on rate limit errors - don't block if we can't check
      return true;
    }
  }

  private getWindowStart(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  }
}