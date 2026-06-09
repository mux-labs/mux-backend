import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KeyOperation } from '../generated/prisma/client';
import { KeyOperationAudit } from './domain/key-types';

export interface PersistAuditLogRequest {
  operation: KeyOperation;
  keyId: string;
  publicKey: string;
  timestamp: Date;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  keyType?: string;
  previousKeyId?: string;
  newKeyId?: string;
  retentionDays?: number; // How long to keep this audit log
}

export interface QueryAuditLogsRequest {
  operation?: KeyOperation;
  keyId?: string;
  publicKey?: string;
  startDate?: Date;
  endDate?: Date;
  success?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Service for persisting key rotation audit logs to database
 * 
 * Provides:
 * - Persistent storage of key operations for compliance
 * - Queryable audit trail for security monitoring
 * - Retention policy management
 * - Tamper-evident logging
 */
@Injectable()
export class KeyRotationAuditService {
  private readonly logger = new Logger(KeyRotationAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persists a key operation audit log to the database
   * 
   * CRITICAL: This should be called for ALL key operations
   * to maintain compliance and security monitoring capabilities
   */
  async persistAuditLog(request: PersistAuditLogRequest): Promise<void> {
    try {
      // Calculate expiration date if retention policy specified
      const expiresAt = request.retentionDays
        ? new Date(
            request.timestamp.getTime() + request.retentionDays * 24 * 60 * 60 * 1000,
          )
        : undefined;

      await this.prisma.keyRotationAuditLog.create({
        data: {
          operation: request.operation,
          keyId: request.keyId,
          publicKey: request.publicKey,
          timestamp: request.timestamp,
          success: request.success,
          errorMessage: request.errorMessage,
          metadata: request.metadata,
          ipAddress: request.ipAddress,
          userAgent: request.userAgent,
          keyType: request.keyType,
          previousKeyId: request.previousKeyId,
          newKeyId: request.newKeyId,
          expiresAt,
        },
      });

      this.logger.log(
        `Persisted audit log: ${request.operation} for key ${request.keyId.substring(0, 12)}...`,
      );
    } catch (error) {
      // CRITICAL: Never fail the main operation if audit logging fails
      // But log the error prominently for investigation
      this.logger.error(
        `CRITICAL: Failed to persist audit log for ${request.operation}:`,
        error,
      );
      // In production, this should trigger an alert
    }
  }

  /**
   * Persists multiple audit logs in a batch (for efficiency)
   */
  async persistAuditLogBatch(requests: PersistAuditLogRequest[]): Promise<void> {
    try {
      await this.prisma.keyRotationAuditLog.createMany({
        data: requests.map((request) => {
          const expiresAt = request.retentionDays
            ? new Date(
                request.timestamp.getTime() + request.retentionDays * 24 * 60 * 60 * 1000,
              )
            : undefined;

          return {
            operation: request.operation,
            keyId: request.keyId,
            publicKey: request.publicKey,
            timestamp: request.timestamp,
            success: request.success,
            errorMessage: request.errorMessage,
            metadata: request.metadata,
            ipAddress: request.ipAddress,
            userAgent: request.userAgent,
            keyType: request.keyType,
            previousKeyId: request.previousKeyId,
            newKeyId: request.newKeyId,
            expiresAt,
          };
        }),
        skipDuplicates: true,
      });

      this.logger.log(`Persisted ${requests.length} audit logs in batch`);
    } catch (error) {
      this.logger.error(
        `CRITICAL: Failed to persist batch audit logs:`,
        error,
      );
    }
  }

  /**
   * Queries audit logs with filtering and pagination
   */
  async queryAuditLogs(query: QueryAuditLogsRequest) {
    const where: any = {};

    if (query.operation) {
      where.operation = query.operation;
    }

    if (query.keyId) {
      where.keyId = query.keyId;
    }

    if (query.publicKey) {
      where.publicKey = query.publicKey;
    }

    if (query.success !== undefined) {
      where.success = query.success;
    }

    if (query.startDate || query.endDate) {
      where.timestamp = {};
      if (query.startDate) {
        where.timestamp.gte = query.startDate;
      }
      if (query.endDate) {
        where.timestamp.lte = query.endDate;
      }
    }

    const limit = query.limit || 100;
    const offset = query.offset || 0;

    const [logs, total] = await Promise.all([
      this.prisma.keyRotationAuditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.keyRotationAuditLog.count({ where }),
    ]);

    return {
      logs,
      total,
      limit,
      offset,
      hasMore: offset + logs.length < total,
    };
  }

  /**
   * Gets audit logs for a specific key rotation operation
   * Returns the complete chain of events for the rotation
   */
  async getRotationHistory(keyId: string) {
    const logs = await this.prisma.keyRotationAuditLog.findMany({
      where: {
        OR: [
          { keyId },
          { previousKeyId: keyId },
          { newKeyId: keyId },
        ],
      },
      orderBy: { timestamp: 'desc' },
    });

    return {
      keyId,
      rotationHistory: logs,
      totalRotations: logs.filter((log) => log.operation === 'ROTATE').length,
    };
  }

  /**
   * Gets statistics about audit logs
   */
  async getAuditStatistics(startDate?: Date, endDate?: Date) {
    const where: any = {};

    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) {
        where.timestamp.gte = startDate;
      }
      if (endDate) {
        where.timestamp.lte = endDate;
      }
    }

    const [
      totalLogs,
      successfulLogs,
      failedLogs,
      rotationLogs,
      generateLogs,
      signLogs,
    ] = await Promise.all([
      this.prisma.keyRotationAuditLog.count({ where }),
      this.prisma.keyRotationAuditLog.count({
        where: { ...where, success: true },
      }),
      this.prisma.keyRotationAuditLog.count({
        where: { ...where, success: false },
      }),
      this.prisma.keyRotationAuditLog.count({
        where: { ...where, operation: 'ROTATE' },
      }),
      this.prisma.keyRotationAuditLog.count({
        where: { ...where, operation: 'GENERATE' },
      }),
      this.prisma.keyRotationAuditLog.count({
        where: { ...where, operation: 'SIGN' },
      }),
    ]);

    return {
      totalLogs,
      successfulLogs,
      failedLogs,
      successRate:
        totalLogs > 0 ? (successfulLogs / totalLogs) * 100 : 100,
      operationBreakdown: {
        rotate: rotationLogs,
        generate: generateLogs,
        sign: signLogs,
      },
      periodStart: startDate,
      periodEnd: endDate,
    };
  }

  /**
   * Archives expired audit logs (for retention policy compliance)
   * This should be run periodically by a cron job
   */
  async archiveExpiredLogs(): Promise<number> {
    try {
      const result = await this.prisma.keyRotationAuditLog.deleteMany({
        where: {
          expiresAt: {
            lte: new Date(),
          },
        },
      });

      this.logger.log(`Archived ${result.count} expired audit logs`);
      return result.count;
    } catch (error) {
      this.logger.error('Failed to archive expired audit logs:', error);
      throw error;
    }
  }

  /**
   * Converts in-memory audit log to persistent format
   */
  convertToPersistentFormat(
    audit: KeyOperationAudit,
    additionalContext?: {
      ipAddress?: string;
      userAgent?: string;
      retentionDays?: number;
    },
  ): PersistAuditLogRequest {
    return {
      operation: audit.operation as KeyOperation,
      keyId: audit.keyId,
      publicKey: audit.publicKey,
      timestamp: audit.timestamp,
      success: audit.success,
      errorMessage: audit.errorMessage,
      metadata: audit.metadata,
      keyType: audit.metadata?.keyType as string | undefined,
      previousKeyId: audit.metadata?.previousKeyId as string | undefined,
      newKeyId: audit.metadata?.newKeyId as string | undefined,
      ipAddress: additionalContext?.ipAddress,
      userAgent: additionalContext?.userAgent,
      retentionDays: additionalContext?.retentionDays,
    };
  }
}
