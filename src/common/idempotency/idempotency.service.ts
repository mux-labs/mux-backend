import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';

export interface IdempotencyCacheOptions {
  ttlMs?: number; // Time to live in milliseconds, defaults to 60 seconds
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly defaultTTLMs = 60000; // 60 seconds default
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient({} as any);
  }

  /**
   * Retrieves a cached response for an idempotency key if it exists and hasn't expired
   */
  async getCachedResponse(key: string): Promise<any | null> {
    try {
      const record = await this.prisma.idempotencyRecord.findUnique({
        where: { key },
      });

      if (!record) {
        return null;
      }

      // Check if record has expired
      if (record.expiresAt < new Date()) {
        // Delete expired record
        await this.prisma.idempotencyRecord.delete({
          where: { key },
        });
        return null;
      }

      this.logger.log(`Idempotency cache hit for key: ${key}`);
      return record.response;
    } catch (error) {
      this.logger.error(`Error retrieving idempotency record for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Stores a response in the idempotency cache
   */
  async cacheResponse(
    key: string,
    response: any,
    method: string,
    endpoint: string,
    statusCode: number = 200,
    options?: IdempotencyCacheOptions,
  ): Promise<void> {
    const ttlMs = options?.ttlMs || this.defaultTTLMs;
    const expiresAt = new Date(Date.now() + ttlMs);

    try {
      // Use upsert to handle race conditions where two requests with same key arrive simultaneously
      await this.prisma.idempotencyRecord.upsert({
        where: { key },
        create: {
          key,
          method,
          endpoint,
          response,
          statusCode,
          expiresAt,
        },
        update: {
          response,
          statusCode,
          expiresAt,
        },
      });

      this.logger.log(
        `Idempotency record cached for key: ${key} with TTL ${ttlMs}ms`,
      );
    } catch (error) {
      this.logger.error(`Error caching idempotency record for key ${key}:`, error);
      // Don't throw - idempotency is a best-effort optimization
    }
  }

  /**
   * Cleans up expired idempotency records (should be called periodically)
   */
  async cleanupExpiredRecords(): Promise<number> {
    try {
      const result = await this.prisma.idempotencyRecord.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
        },
      });

      this.logger.log(`Cleaned up ${result.count} expired idempotency records`);
      return result.count;
    } catch (error) {
      this.logger.error('Error cleaning up expired idempotency records:', error);
      return 0;
    }
  }
}
