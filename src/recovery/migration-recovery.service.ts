import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface MigrationFailureRecord {
  name: string;
  failedAt: Date;
  error: string;
  appliedAt?: Date;
  rolledBackAt?: Date;
  status: 'FAILED' | 'ROLLED_BACK' | 'RECOVERED';
}

/**
 * Handles recovery from failed database migrations.
 *
 * Provides utilities to:
 * - Detect and log migration failures
 * - Track migration state transitions
 * - Support rollback and recovery operations
 * - Audit trail for migration attempts
 */
@Injectable()
export class MigrationRecoveryService {
  private readonly logger = new Logger(MigrationRecoveryService.name);
  private failedMigrations: Map<string, MigrationFailureRecord> = new Map();

  constructor(private prisma: PrismaService) {}

  /**
   * Records a migration failure for audit and recovery purposes.
   */
  recordMigrationFailure(
    migrationName: string,
    error: Error,
  ): MigrationFailureRecord {
    const record: MigrationFailureRecord = {
      name: migrationName,
      failedAt: new Date(),
      error: error.message,
      status: 'FAILED',
    };

    this.failedMigrations.set(migrationName, record);
    this.logger.error(
      `Migration ${migrationName} failed: ${error.message}`,
      error.stack,
    );

    return record;
  }

  /**
   * Marks a failed migration as rolled back.
   */
  recordMigrationRollback(migrationName: string): MigrationFailureRecord {
    const record = this.failedMigrations.get(migrationName);

    if (!record) {
      throw new BadRequestException(
        `No failed migration record found for ${migrationName}`,
      );
    }

    record.rolledBackAt = new Date();
    record.status = 'ROLLED_BACK';
    this.logger.info(`Migration ${migrationName} rolled back successfully`);

    return record;
  }

  /**
   * Marks a failed migration as recovered (retry succeeded).
   */
  recordMigrationRecovery(migrationName: string): MigrationFailureRecord {
    const record = this.failedMigrations.get(migrationName);

    if (!record) {
      throw new BadRequestException(
        `No failed migration record found for ${migrationName}`,
      );
    }

    record.appliedAt = new Date();
    record.status = 'RECOVERED';
    this.logger.info(`Migration ${migrationName} recovered successfully`);

    return record;
  }

  /**
   * Retrieves all failed migration records.
   */
  getFailedMigrations(): MigrationFailureRecord[] {
    return Array.from(this.failedMigrations.values());
  }

  /**
   * Retrieves a specific failed migration record.
   */
  getFailedMigration(migrationName: string): MigrationFailureRecord | undefined {
    return this.failedMigrations.get(migrationName);
  }

  /**
   * Clears recovery history for a migration (after successful resolution).
   */
  clearMigrationHistory(migrationName: string): void {
    this.failedMigrations.delete(migrationName);
    this.logger.debug(`Cleared recovery history for ${migrationName}`);
  }

  /**
   * Clears all recovery history.
   */
  clearAllHistory(): void {
    this.failedMigrations.clear();
    this.logger.debug('Cleared all migration recovery history');
  }
}
