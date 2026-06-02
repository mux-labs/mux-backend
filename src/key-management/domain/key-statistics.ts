/**
 * Domain types for key management statistics
 */

export interface KeyStatistics {
  totalKeysGenerated: number;
  totalSigningOperations: number;
  totalValidations: number;
  totalFailures: number;
  keysByType: Record<string, number>;
  operationsByType: Record<string, number>;
  successRate: number;
  averageOperationTime?: number;
  lastOperation?: Date;
  periodStart: Date;
  periodEnd: Date;
}

export interface KeyOperationMetrics {
  operation: string;
  count: number;
  successCount: number;
  failureCount: number;
  successRate: number;
}

export interface TimeSeriesPoint {
  timestamp: Date;
  count: number;
  operation: string;
}

export interface KeyStatisticsQuery {
  startDate?: Date;
  endDate?: Date;
  keyType?: string;
  operation?: string;
  includeTimeSeries?: boolean;
}

export interface DetailedKeyStatistics extends KeyStatistics {
  operationMetrics: KeyOperationMetrics[];
  timeSeries?: TimeSeriesPoint[];
  recentOperations: {
    operation: string;
    timestamp: Date;
    success: boolean;
    keyType?: string;
  }[];
}
