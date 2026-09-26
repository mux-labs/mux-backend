import { Injectable, Logger } from '@nestjs/common';
import { KeyAuditLogEntry, AuditLogQueryParams, KeyOperation, KeyType } from './domain/key-types';
import { AuditEntry } from './domain/key-statistics';

/**
 * In-memory audit log service for key management operations.
 * In production, this should be replaced with a persistent store.
 */
@Injectable()
export class KeyRotationAuditService {
  private readonly logger = new Logger(KeyRotationAuditService.name);
  private readonly auditLog: KeyAuditLogEntry[] = [];
  private readonly MAX_ENTRIES = 1000;

  /**
   * Add an audit log entry.
   */
  logEntry(entry: Omit<KeyAuditLogEntry, 'id'>): void {
    const fullEntry: KeyAuditLogEntry = {
      ...entry,
      id: this.generateId(),
    };

    this.auditLog.unshift(fullEntry);

    // Prune old entries to keep memory bounded
    if (this.auditLog.length > this.MAX_ENTRIES) {
      this.auditLog.splice(this.MAX_ENTRIES);
    }

    this.logger.debug(
      `Key audit: ${entry.operation} ${entry.keyType} ${entry.success ? 'success' : 'failure'} requestId=${entry.requestId ?? 'none'}`,
    );
  }

  /**
   * Get audit logs with optional filtering.
   */
  getAuditLogs(params: AuditLogQueryParams = {}): KeyAuditLogEntry[] {
    let logs = [...this.auditLog];

    if (params.operation) {
      logs = logs.filter((l) => l.operation === params.operation);
    }
    if (params.keyType) {
      logs = logs.filter((l) => l.keyType === params.keyType);
    }
    if (params.success !== undefined) {
      logs = logs.filter((l) => l.success === params.success);
    }
    if (params.startDate) {
      const start = new Date(params.startDate).getTime();
      logs = logs.filter((l) => new Date(l.timestamp).getTime() >= start);
    }
    if (params.endDate) {
      const end = new Date(params.endDate).getTime();
      logs = logs.filter((l) => new Date(l.timestamp).getTime() <= end);
    }

    if (params.limit && params.limit > 0) {
      logs = logs.slice(0, params.limit);
    }

    return logs;
  }

  /**
   * Get statistics from the audit log.
   */
  getStatistics(params: AuditLogQueryParams = {}): AuditEntry[] {
    const logs = this.getAuditLogs(params);
    return logs.map((l) => ({
      operation: l.operation,
      keyType: l.keyType,
      timestamp: l.timestamp,
      success: l.success,
    }));
  }

  /**
   * Clear all audit logs (for testing).
   */
  clear(): void {
    this.auditLog.length = 0;
  }

  /**
   * Get the current count of audit entries.
   */
  getCount(): number {
    return this.auditLog.length;
  }

  /**
   * Persist audit logs to external storage (stub for future implementation).
   * This would typically push to a database, S3, or SIEM system.
   */
  async persistAuditLog(): Promise<void> {
    // In production, implement persistence to database/S3/SIEM
    this.logger.log(`Persisting ${this.auditLog.length} audit entries (stub)`);
  }

  /**
   * Convert audit logs to a persistent format (stub).
   */
  convertToPersistentFormat(): unknown {
    return this.auditLog.map((entry) => ({
      id: entry.id,
      operation: entry.operation,
      keyType: entry.keyType,
      timestamp: entry.timestamp,
      success: entry.success,
      error: entry.error,
      metadata: entry.metadata,
      requestId: entry.requestId,
    }));
  }

  /**
   * Get rotation history (stub for future implementation).
   */
  async getRotationHistory(): Promise<{ history: unknown[] }> {
    return { history: [] };
  }

  /**
   * Get audit statistics (stub for future implementation).
   */
  async getAuditStatistics(): Promise<{ total: number }> {
    return { total: this.auditLog.length };
  }

  /**
   * Query audit logs for external use (stub).
   */
  async queryAuditLogs(): Promise<{ logs: unknown[]; total: number }> {
    return { logs: this.auditLog, total: this.auditLog.length };
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}