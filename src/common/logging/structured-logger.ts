import { Logger } from '@nestjs/common';

/**
 * Standard context fields for structured logging across the application.
 */
export interface LogContext {
  /** Request ID for tracing */
  requestId?: string;
  /** User ID performing the action */
  userId?: string;
  /** Entity ID being operated on (wallet, payment, etc.) */
  entityId?: string;
  /** Entity type (wallet, payment, limit, etc.) */
  entityType?: string;
  /** Operation being performed (create, update, delete, etc.) */
  operation?: string;
  /** Outcome of the operation (success, failure, pending, etc.) */
  outcome?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Additional arbitrary fields */
  [key: string]: unknown;
}

/**
 * Structured logger that adds consistent context fields to all log messages.
 * Extends NestJS Logger with methods that include structured context.
 */
export class StructuredLogger extends Logger {
  /**
   * Log an informational message with context.
   */
  logWithContext(message: string, context?: LogContext): void {
    const contextStr = this.formatContext(context);
    this.log(`${message}${contextStr}`);
  }

  /**
   * Log a warning message with context.
   */
  warnWithContext(message: string, context?: LogContext): void {
    const contextStr = this.formatContext(context);
    this.warn(`${message}${contextStr}`);
  }

  /**
   * Log an error message with context.
   */
  errorWithContext(
    message: string,
    error?: unknown,
    context?: LogContext,
  ): void {
    const contextStr = this.formatContext(context);
    const errorStr = error
      ? ` error=${error instanceof Error ? error.message : String(error)}`
      : '';
    this.error(`${message}${contextStr}${errorStr}`);
  }

  /**
   * Log a debug message with context.
   */
  debugWithContext(message: string, context?: LogContext): void {
    const contextStr = this.formatContext(context);
    this.debug(`${message}${contextStr}`);
  }

  /**
   * Format context fields as a string suitable for structured logs.
   * Output: " requestId=abc userId=123 entityId=wallet-1 operation=create"
   */
  private formatContext(context?: LogContext): string {
    if (!context || Object.keys(context).length === 0) {
      return '';
    }

    const fields: string[] = [];
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== '') {
        fields.push(`${key}=${this.escapeValue(value)}`);
      }
    }

    return fields.length > 0 ? ` ${fields.join(' ')}` : '';
  }

  /**
   * Escape values for safe structured logging.
   */
  private escapeValue(value: unknown): string {
    if (typeof value === 'string') {
      // Quote strings that contain spaces or special characters
      if (/\s|[=]/.test(value)) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      return String(value);
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return JSON.stringify(value);
  }
}
