import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';

export interface AuthRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: Date;
  limit: number;
  retryAfterSeconds?: number;
}

@Injectable()
export class AuthRateLimitService {
  private readonly logger = new Logger(AuthRateLimitService.name);
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private prisma: PrismaClient;

  constructor(private readonly configService: ConfigService) {
    // Read from env vars with sensible defaults: 10 requests per 60 seconds
    this.maxRequests = parseInt(
      this.configService.get<string>('AUTH_RATE_LIMIT_MAX', '10'),
      10,
    );
    this.windowMs = parseInt(
      this.configService.get<string>('AUTH_RATE_LIMIT_WINDOW_MS', '60000'),
      10,
    );

    this.logger.log(
      `AuthRateLimitService initialized: ${this.maxRequests} requests per ${this.windowMs}ms`,
    );

    this.prisma = new PrismaClient({} as any);
  }

  /**
   * Checks if a request from the given IP is within rate limit.
   * Returns error with 429 status if limit exceeded.
   */
  async checkRateLimit(ipAddress: string): Promise<AuthRateLimitResult> {
    const now = new Date();
    const windowStart = new Date(
      Math.floor(now.getTime() / this.windowMs) * this.windowMs,
    );
    const key = `auth-rate-limit:${ipAddress}`;

    try {
      // Find or create rate limit record for this IP in current window
      let record = await this.prisma.rateLimitRecord.findUnique({
        where: {
          apiKeyId_endpoint_windowStart: {
            apiKeyId: key, // Reuse apiKeyId for IP address
            endpoint: 'POST /auth/authenticate',
            windowStart,
          },
        },
      });

      // If no record exists, create new one for current window
      if (!record) {
        // Clean up old records for this IP
        await this.prisma.rateLimitRecord.deleteMany({
          where: {
            apiKeyId: key,
            endpoint: 'POST /auth/authenticate',
            windowStart: { lt: windowStart },
          },
        });

        // Create new record for current window
        record = await this.prisma.rateLimitRecord.create({
          data: {
            apiKeyId: key,
            endpoint: 'POST /auth/authenticate',
            windowStart,
            requestCount: 1,
          },
        });

        return {
          allowed: true,
          remaining: this.maxRequests - 1,
          resetTime: new Date(windowStart.getTime() + this.windowMs),
          limit: this.maxRequests,
        };
      }

      // Check if limit exceeded
      if (record.requestCount >= this.maxRequests) {
        const resetTime = new Date(
          record.windowStart.getTime() + this.windowMs,
        );
        const retryAfterSeconds = Math.ceil(
          (resetTime.getTime() - Date.now()) / 1000,
        );

        this.logger.warn(
          `Auth rate limit exceeded for IP ${ipAddress}: ${record.requestCount}/${this.maxRequests} requests`,
        );

        return {
          allowed: false,
          remaining: 0,
          resetTime,
          limit: this.maxRequests,
          retryAfterSeconds,
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
        remaining: this.maxRequests - updated.requestCount,
        resetTime: new Date(record.windowStart.getTime() + this.windowMs),
        limit: this.maxRequests,
      };
    } catch (error) {
      this.logger.error(
        `Error checking auth rate limit for IP ${ipAddress}:`,
        error,
      );
      // On error, allow the request (fail open) but log the error
      return {
        allowed: true,
        remaining: this.maxRequests,
        resetTime: new Date(now.getTime() + this.windowMs),
        limit: this.maxRequests,
      };
    }
  }

  /**
   * Gets the configured rate limit values
   */
  getConfig(): { maxRequests: number; windowMs: number } {
    return {
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
    };
  }
}
