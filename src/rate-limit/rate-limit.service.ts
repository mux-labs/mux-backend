import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: Date;
  limit: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly defaultConfig: RateLimitConfig;
  private readonly sensitiveConfig: RateLimitConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    // Default rate limits (configurable via environment)
    this.defaultConfig = {
      windowMs: parseInt(
        this.configService.get<string>('RATE_LIMIT_WINDOW_MS', '60000'),
      ), // 1 minute default
      maxRequests: parseInt(
        this.configService.get<string>('RATE_LIMIT_MAX_REQUESTS', '100'),
      ), // 100 requests per minute default
    };

    // Stricter limits for sensitive endpoints
    this.sensitiveConfig = {
      windowMs: parseInt(
        this.configService.get<string>(
          'RATE_LIMIT_SENSITIVE_WINDOW_MS',
          '60000',
        ),
      ), // 1 minute default
      maxRequests: parseInt(
        this.configService.get<string>(
          'RATE_LIMIT_SENSITIVE_MAX_REQUESTS',
          '10',
        ),
      ), // 10 requests per minute for sensitive endpoints
    };
  }

  /**
   * Checks if a request should be allowed based on rate limits
   */
  async checkRateLimit(
    apiKeyId: string,
    endpoint: string,
    isSensitive: boolean = false,
  ): Promise<RateLimitResult> {
    const config = isSensitive ? this.sensitiveConfig : this.defaultConfig;
    const now = new Date();

    // Calculate window start by rounding down to the nearest window boundary
    const windowStart = new Date(
      Math.floor(now.getTime() / config.windowMs) * config.windowMs,
    );

    try {
      // Find or create rate limit record
      let record = await this.prisma.rateLimitRecord.findUnique({
        where: {
          apiKeyId_endpoint_windowStart: {
            apiKeyId,
            endpoint,
            windowStart,
          },
        },
      });

      // If no record exists, create new record for current window
      if (!record) {
        // Delete old records for this API key and endpoint (cleanup)
        await this.prisma.rateLimitRecord.deleteMany({
          where: {
            apiKeyId,
            endpoint,
            windowStart: { lt: windowStart },
          },
        });

        // Create new record for current window
        record = await this.prisma.rateLimitRecord.create({
          data: {
            apiKeyId,
            endpoint,
            windowStart,
            requestCount: 1,
          },
        });

        return {
          allowed: true,
          remaining: config.maxRequests - 1,
          resetTime: new Date(windowStart.getTime() + config.windowMs),
          limit: config.maxRequests,
        };
      }

      // Check if limit exceeded
      if (record.requestCount >= config.maxRequests) {
        const resetTime = new Date(
          record.windowStart.getTime() + config.windowMs,
        );

        // Log the rejected request
        this.logRejectedRequest(apiKeyId, endpoint, isSensitive, {
          current: record.requestCount,
          limit: config.maxRequests,
          resetTime,
        });

        return {
          allowed: false,
          remaining: 0,
          resetTime,
          limit: config.maxRequests,
        };
      }

      // Increment request count
      const updated = await this.prisma.rateLimitRecord.update({
        where: { id: record.id },
        data: {
          requestCount: { increment: 1 },
          updatedAt: now,
        },
      });

      return {
        allowed: true,
        remaining: config.maxRequests - updated.requestCount,
        resetTime: new Date(record.windowStart.getTime() + config.windowMs),
        limit: config.maxRequests,
      };
    } catch (error) {
      this.logger.error(
        `Error checking rate limit for API key ${apiKeyId} on ${endpoint}:`,
        error,
      );
      // On error, allow the request (fail open) but log the error
      return {
        allowed: true,
        remaining: config.maxRequests,
        resetTime: new Date(now.getTime() + config.windowMs),
        limit: config.maxRequests,
      };
    }
  }

  /**
   * Logs rejected requests for monitoring
   */
  private logRejectedRequest(
    apiKeyId: string,
    endpoint: string,
    isSensitive: boolean,
    details: { current: number; limit: number; resetTime: Date },
  ): void {
    this.logger.warn(
      `Rate limit exceeded: API key ${apiKeyId.substring(0, 8)}... on ${endpoint} (${isSensitive ? 'SENSITIVE' : 'NORMAL'}) - ${details.current}/${details.limit} requests. Resets at ${details.resetTime.toISOString()}`,
    );
  }

  /**
   * Gets current rate limit configuration
   */
  getConfig(isSensitive: boolean = false): RateLimitConfig {
    return isSensitive ? this.sensitiveConfig : this.defaultConfig;
  }

  /**
   * Cleans up old rate limit records (should be called periodically)
   */
  async cleanupOldRecords(olderThanMs: number = 3600000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.rateLimitRecord.deleteMany({
      where: {
        windowStart: { lt: cutoff },
      },
    });
    this.logger.log(`Cleaned up ${result.count} old rate limit records`);
    return result.count;
  }
}
