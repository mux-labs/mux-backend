import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

export interface ApiKeyInfo {
  id: string;
  name?: string;
  environment: string;
  isActive: boolean;
}

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates an API key and returns its information
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyInfo | null> {
    if (!apiKey) {
      return null;
    }

    try {
      // Hash the provided key to compare with stored hashed keys
      const hashedKey = this.hashApiKey(apiKey);

      const keyRecord = await this.prisma.apiKey.findUnique({
        where: { key: hashedKey },
      });

      if (!keyRecord || !keyRecord.isActive) {
        return null;
      }

      // Update last used timestamp
      await this.prisma.apiKey.update({
        where: { id: keyRecord.id },
        data: { lastUsedAt: new Date() },
      });

      return {
        id: keyRecord.id,
        name: keyRecord.name || undefined,
        environment: keyRecord.environment,
        isActive: keyRecord.isActive,
      };
    } catch (error) {
      this.logger.error('Error validating API key:', error);
      return null;
    }
  }

  /**
   * Creates a new API key
   */
  async createApiKey(
    name?: string,
    environment: string = 'production',
  ): Promise<{ apiKey: string; info: ApiKeyInfo }> {
    // Generate a secure random API key
    const rawKey = this.generateApiKey();
    const hashedKey = this.hashApiKey(rawKey);

    const keyRecord = await this.prisma.apiKey.create({
      data: {
        key: hashedKey,
        name,
        environment,
        isActive: true,
      },
    });

    return {
      apiKey: rawKey, // Return the raw key only once
      info: {
        id: keyRecord.id,
        name: keyRecord.name || undefined,
        environment: keyRecord.environment,
        isActive: keyRecord.isActive,
      },
    };
  }

  /**
   * Generates a secure random API key
   */
  private generateApiKey(): string {
    // Generate a 32-byte random key and encode as base64url
    const randomBytes = crypto.randomBytes(32);
    return `mux_${randomBytes.toString('base64url')}`;
  }

  /**
   * Hashes an API key for storage
   */
  private hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Revokes an API key
   */
  async revokeApiKey(apiKeyId: string): Promise<void> {
    await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { isActive: false },
    });
  }
}
