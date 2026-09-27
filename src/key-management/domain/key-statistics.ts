import { KeyType, KeyOperation } from './key-types';

/**
 * Basic key management statistics.
 */
export interface KeyStatistics {
  /** Total number of keys generated */
  totalKeysGenerated: number;

  /** Total number of signing operations */
  totalSigningOperations: number;

  /** Total number of validation operations */
  totalValidations: number;

  /** Total number of failed operations */
  totalFailures: number;

  /** Keys grouped by type */
  keysByType: Record<KeyType, number>;

  /** Operations grouped by type */
  operationsByType: Record<KeyOperation, number>;

  /** Overall success rate (percentage) */
  successRate: number;

  /** Timestamp of the last operation */
  lastOperation: string | null;

  /** Start of the period */
  periodStart: string;

  /** End of the period */
  periodEnd: string;
}

/**
 * Per-operation metrics for detailed statistics.
 */
export interface OperationMetrics {
  /** The operation type */
  operation: KeyOperation;

  /** Total count of this operation */
  count: number;

  /** Number of successful operations */
  successCount: number;

  /** Number of failed operations */
  failureCount: number;

  /** Success rate for this operation type (percentage) */
  successRate: number;
}

/**
 * Recent operation entry.
 */
export interface RecentOperation {
  /** The operation type */
  operation: KeyOperation;

  /** ISO timestamp of the operation */
  timestamp: string;

  /** Whether the operation succeeded */
  success: boolean;

  /** The key type */
  keyType: KeyType;
}

/**
 * Time series data point (hourly aggregation).
 */
export interface TimeSeriesPoint {
  /** Hour bucket timestamp (start of hour) */
  timestamp: string;

  /** Number of operations in this hour */
  count: number;

  /** The operation type */
  operation: KeyOperation;
}

/**
 * Detailed key management statistics with extended metrics.
 */
export interface DetailedKeyStatistics extends KeyStatistics {
  /** Per-operation metrics */
  operationMetrics: OperationMetrics[];

  /** Recent operations (last 10) */
  recentOperations: RecentOperation[];

  /** Optional hourly time series data */
  timeSeries?: TimeSeriesPoint[];
}

/**
 * Query parameters for statistics.
 */
export interface StatisticsQueryParams {
  /** Start date (ISO string) */
  startDate?: string;

  /** End date (ISO string) */
  endDate?: string;

  /** Filter by operation type */
  operation?: KeyOperation;

  /** Include time series data (detailed only) */
  includeTimeSeries?: boolean;
}

/**
 * Internal audit entry used for computing statistics.
 */
export interface AuditEntry {
  operation: KeyOperation;
  keyType: KeyType;
  timestamp: string;
  success: boolean;
}