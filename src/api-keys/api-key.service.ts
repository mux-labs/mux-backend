import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import * as crypto from 'crypto';
import {
  ApiKey,
  ApiKeyStatus,
  Developer,
  Project,
} from './domain/api-key.model';

export interface CreateApiKeyRequest {
  name: string;
  projectId: string;
  expiresAt?: Date;
}

export interface CreateApiKeyResult {
  apiKey: ApiKey;
  plainTextKey: string; // Only returned once during creation
}

export interface RotateApiKeyRequest {
  apiKeyId: string;
  name?: string;
}

export interface ListApiKeysRequest {
  projectId: string;
  page?: number;
  pageSize?: number;
  developerId?: string;
}

/**
 * Service for managing API keys
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private prisma: PrismaClient;
  private readonly gracePeriodSeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.prisma = new PrismaClient({} as any);
    this.gracePeriodSeconds =
      this.configService.get<number>('API_KEY_ROTATION_GRACE_SECONDS') ?? 3600;
  }

  /**
   * Generates a new API key for a project
   * Format: mux_{environment}_{random32chars}
   */
  async createApiKey(
    request: CreateApiKeyRequest,
  ): Promise<CreateApiKeyResult> {
    this.logger.log(`Creating API key for project: ${request.projectId}`);

    // Validate project exists
    const project = await this.prisma.project.findUnique({
      where: { id: request.projectId },
    });

    if (!project) {
      throw new Error(`Project ${request.projectId} not found`);
    }

    // Generate API key
    const environment = project.environment === 'production' ? 'live' : 'test';
    const randomPart = crypto.randomBytes(24).toString('base64url'); // 32 chars
    const plainTextKey = `mux_${environment}_${randomPart}`;

    // Hash the key for storage
    const keyHash = this.hashApiKey(plainTextKey);

    // Extract metadata
    const keyPrefix = `mux_${environment}_`;
    const lastFour = randomPart.slice(-4);

    // Store hashed key
    const apiKey = await this.prisma.apiKey.create({
      data: {
        name: request.name,
        keyHash,
        keyPrefix,
        lastFour,
        projectId: request.projectId,
        status: ApiKeyStatus.ACTIVE,
        expiresAt: request.expiresAt,
      },
    });

    this.logger.log(
      `Created API key: ${apiKey.id} for project: ${request.projectId}`,
    );

    return {
      apiKey: this.mapPrismaApiKeyToDomain(apiKey),
      plainTextKey, // Only returned once!
    };
  }

  /**
   * Validates an API key and returns context if valid
   */
  async validateApiKey(plainTextKey: string): Promise<{
    apiKey: ApiKey;
    project: Project;
    developer: Developer;
  }> {
    if (!plainTextKey || !plainTextKey.startsWith('mux_')) {
      throw new UnauthorizedException('Invalid API key format');
    }

    // Hash the provided key
    const keyHash = this.hashApiKey(plainTextKey);

    // Find the API key with relations
    const apiKeyRecord = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        project: {
          include: {
            developer: true,
          },
        },
      },
    });

    if (!apiKeyRecord) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Check if key is active or in grace period
    if (apiKeyRecord.status === ApiKeyStatus.REVOKED) {
      throw new UnauthorizedException('API key has been revoked');
    }

    if (apiKeyRecord.status === ApiKeyStatus.SUSPENDED) {
      throw new UnauthorizedException('API key is suspended');
    }

    if (apiKeyRecord.status === ApiKeyStatus.EXPIRED) {
      throw new UnauthorizedException('API key has expired');
    }

    // Check if grace period has ended (for rotated keys)
    if (
      apiKeyRecord.gracePeriodEndsAt &&
      apiKeyRecord.gracePeriodEndsAt < new Date()
    ) {
      throw new UnauthorizedException('API key rotation grace period expired');
    }

    // Check expiration
    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      // Mark as expired
      await this.prisma.apiKey.update({
        where: { id: apiKeyRecord.id },
        data: { status: ApiKeyStatus.EXPIRED },
      });
      throw new UnauthorizedException('API key has expired');
    }

    // Update last used timestamp (async, don't await)
    this.updateLastUsed(apiKeyRecord.id).catch((err) =>
      this.logger.error(
        `Failed to update lastUsedAt for key ${apiKeyRecord.id}:`,
        err,
      ),
    );

    return {
      apiKey: this.mapPrismaApiKeyToDomain(apiKeyRecord),
      project: apiKeyRecord.project,
      developer: apiKeyRecord.project.developer,
    };
  }

  /**
   * Revokes an API key (idempotent - revoking already-revoked key succeeds)
   */
  async revokeApiKey(
    apiKeyId: string,
    reason?: string,
    developerId?: string,
  ): Promise<ApiKey> {
    this.logger.log(`Revoking API key: ${apiKeyId}`);

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      include: { project: true },
    });

    if (!apiKey) {
      throw new Error(`API key ${apiKeyId} not found`);
    }

    // Verify ownership if developerId provided
    if (developerId && apiKey.project.developerId !== developerId) {
      throw new UnauthorizedException('You do not have access to this API key');
    }

    // If already revoked, return success (idempotent)
    if (apiKey.status === ApiKeyStatus.REVOKED) {
      return this.mapPrismaApiKeyToDomain(apiKey);
    }

    const updated = await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: {
        status: ApiKeyStatus.REVOKED,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });

    this.logger.log(`Revoked API key: ${apiKeyId}`);
    return this.mapPrismaApiKeyToDomain(updated);
  }

  /**
   * Rotates an API key (creates new, marks old with grace period)
   */
  async rotateApiKey(
    request: RotateApiKeyRequest,
    developerId?: string,
  ): Promise<CreateApiKeyResult> {
    this.logger.log(`Rotating API key: ${request.apiKeyId}`);

    const oldKey = await this.prisma.apiKey.findUnique({
      where: { id: request.apiKeyId },
      include: { project: true },
    });

    if (!oldKey) {
      throw new Error(`API key ${request.apiKeyId} not found`);
    }

    // Verify ownership if developerId provided
    if (developerId && oldKey.project.developerId !== developerId) {
      throw new UnauthorizedException('You do not have access to this API key');
    }

    // Create new key
    const newKeyResult = await this.createApiKey({
      name: request.name || `${oldKey.name} (rotated)`,
      projectId: oldKey.projectId,
      expiresAt: oldKey.expiresAt || undefined,
    });

    // Mark old key with grace period instead of revoking immediately
    const gracePeriodEndsAt = new Date(
      Date.now() + this.gracePeriodSeconds * 1000,
    );
    await this.prisma.apiKey.update({
      where: { id: request.apiKeyId },
      data: {
        gracePeriodEndsAt,
      },
    });

    this.logger.log(
      `Rotated API key: ${request.apiKeyId} -> ${newKeyResult.apiKey.id} (grace period until ${gracePeriodEndsAt.toISOString()})`,
    );
    return newKeyResult;
  }

  /**
   * Lists API keys for a project with optional pagination
   */
  async listApiKeys(request: ListApiKeysRequest): Promise<{
    keys: ApiKey[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = request.page ?? 1;
    const pageSize = request.pageSize ?? 10;
    const skip = (page - 1) * pageSize;

    // If developerId is provided, verify they own the project
    if (request.developerId) {
      const project = await this.prisma.project.findUnique({
        where: { id: request.projectId },
      });
      if (!project || project.developerId !== request.developerId) {
        throw new UnauthorizedException(
          'You do not have access to this project',
        );
      }
    }

    const [keys, total] = await Promise.all([
      this.prisma.apiKey.findMany({
        where: { projectId: request.projectId },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.apiKey.count({
        where: { projectId: request.projectId },
      }),
    ]);

    return {
      keys: keys.map((key) => this.mapPrismaApiKeyToDomain(key)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Records API key usage for analytics
   */
  async recordUsage(
    apiKeyId: string,
    projectId: string,
    endpoint: string,
    method: string,
    statusCode?: number,
    ipAddress?: string,
    userAgent?: string,
    responseTime?: number,
  ): Promise<void> {
    try {
      await this.prisma.apiKeyUsage.create({
        data: {
          apiKeyId,
          projectId,
          endpoint,
          method,
          statusCode,
          ipAddress,
          userAgent,
          responseTime,
        },
      });
    } catch (error) {
      // Don't fail request if usage recording fails
      this.logger.error('Failed to record API key usage:', error);
    }
  }

  /**
   * Hashes an API key using SHA-256
   */
  private hashApiKey(plainTextKey: string): string {
    return crypto.createHash('sha256').update(plainTextKey).digest('hex');
  }

  /**
   * Updates last used timestamp for an API key
   */
  private async updateLastUsed(apiKeyId: string): Promise<void> {
    await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { lastUsedAt: new Date() },
    });
  }

  /**
   * Maps Prisma ApiKey to domain model
   */
  private mapPrismaApiKeyToDomain(prismaApiKey: any): ApiKey {
    return {
      id: prismaApiKey.id,
      name: prismaApiKey.name,
      keyHash: prismaApiKey.keyHash,
      keyPrefix: prismaApiKey.keyPrefix,
      lastFour: prismaApiKey.lastFour,
      projectId: prismaApiKey.projectId,
      status: prismaApiKey.status as ApiKeyStatus,
      expiresAt: prismaApiKey.expiresAt,
      lastUsedAt: prismaApiKey.lastUsedAt,
      revokedAt: prismaApiKey.revokedAt,
      revokedReason: prismaApiKey.revokedReason,
      gracePeriodEndsAt: prismaApiKey.gracePeriodEndsAt,
      createdAt: prismaApiKey.createdAt,
      updatedAt: prismaApiKey.updatedAt,
    };
  }
}
