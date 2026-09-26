import { Injectable, Logger, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createHash, timingSafeEqual, randomBytes } from 'crypto';

/**
 * Service for managing API keys with secure hashing and validation.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates an API key and returns the associated key, project, and developer info.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  async validateApiKey(providedKey: string): Promise<{
    apiKey: { id: string; projectId: string; keyPrefix: string; lastFour: string };
    project: { id: string; rateLimitRpm: number; developerId: string };
    developer: { id: string };
  }> {
    if (!providedKey || providedKey.length < 10) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const keyHash = this.hashKey(providedKey);

    try {
      const apiKey = await this.prisma.apiKey.findUnique({
        where: { keyHash },
        include: {
          project: {
            include: {
              developer: true,
            },
          },
        },
      });

      if (!apiKey) {
        this.logger.warn('API key not found');
        throw new UnauthorizedException('Invalid API key');
      }

      if (apiKey.status !== 'ACTIVE') {
        this.logger.warn(`API key status is ${apiKey.status}`);
        throw new UnauthorizedException('API key is not active');
      }

      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        this.logger.warn('API key has expired');
        throw new UnauthorizedException('API key has expired');
      }

      // Timing-safe comparison as defense in depth
      const providedHashBuffer = Buffer.from(keyHash);
      const storedHashBuffer = Buffer.from(apiKey.keyHash);
      
      if (providedHashBuffer.length !== storedHashBuffer.length || 
          !timingSafeEqual(providedHashBuffer, storedHashBuffer)) {
        this.logger.warn('API key hash mismatch');
        throw new UnauthorizedException('Invalid API key');
      }

      // Update last used timestamp
      await this.prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      });

      return {
        apiKey: {
          id: apiKey.id,
          projectId: apiKey.projectId,
          keyPrefix: apiKey.keyPrefix,
          lastFour: apiKey.lastFour,
        },
        project: {
          id: apiKey.project.id,
          rateLimitRpm: apiKey.project.rateLimitRpm,
          developerId: apiKey.project.developerId,
        },
        developer: {
          id: apiKey.project.developer.id,
        },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error('API key validation failed', error);
      throw new ServiceUnavailableException('API key validation service unavailable');
    }
  }

  /**
   * Creates a new API key and returns the plaintext key (only shown once).
   */
  async createApiKey(data: {
    name: string;
    projectId: string;
    network?: 'MAINNET' | 'TESTNET';
    expiresAt?: Date;
  }): Promise<{ apiKey: string; keyPrefix: string; lastFour: string }> {
    const prefix = data.network === 'MAINNET' ? 'mux_live_' : 'mux_test_';
    const randomPart = randomBytes(24).toString('base64url');
    const plaintextKey = `${prefix}${randomPart}`;
    
    const keyHash = this.hashKey(plaintextKey);
    const keyPrefix = plaintextKey.slice(0, 9); // e.g., "mux_test_"
    const lastFour = plaintextKey.slice(-4);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        name: data.name,
        keyHash,
        keyPrefix,
        lastFour,
        projectId: data.projectId,
        network: data.network,
        expiresAt: data.expiresAt,
      },
    });

    this.logger.log(`Created API key ${apiKey.id} for project ${data.projectId}`);

    return {
      apiKey: plaintextKey,
      keyPrefix,
      lastFour,
    };
  }

  /**
   * Hashes an API key using SHA-256.
   */
  private hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  /**
   * Records API key usage for analytics and rate limiting.
   */
  async recordUsage(data: {
    apiKeyId: string;
    projectId: string;
    endpoint: string;
    method: string;
    statusCode: number;
    ipAddress: string;
    userAgent: string;
    responseTime: number;
  }): Promise<void> {
    try {
      await this.prisma.apiKeyUsage.create({
        data: {
          apiKeyId: data.apiKeyId,
          projectId: data.projectId,
          endpoint: data.endpoint,
          method: data.method,
          statusCode: data.statusCode,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent,
          responseTime: data.responseTime,
        },
      });
    } catch (error) {
      this.logger.error('Failed to record API key usage', error);
      // Non-blocking - don't throw on analytics failure
    }
  }
}