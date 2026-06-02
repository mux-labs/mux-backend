# Key Management Statistics Feature

## Overview

The Key Management Statistics feature provides comprehensive insights into key generation and usage patterns. This helps with monitoring, security analysis, and operational visibility.

## Features

### 1. Basic Statistics

Track high-level metrics:
- Total keys generated
- Total signing operations
- Total validations
- Total failures
- Success rate
- Keys by type (Stellar, Ethereum, etc.)
- Operations by type (GENERATE, SIGN, ACCESS, etc.)

### 2. Detailed Statistics

Extended metrics including:
- Per-operation metrics (count, success/failure breakdown)
- Recent operations (last 10)
- Optional hourly time series data
- Success rates per operation type

### 3. Flexible Querying

Filter statistics by:
- Date range (startDate, endDate)
- Operation type (GENERATE, SIGN, etc.)
- Include/exclude time series data

## API Endpoints

### GET /internal/key-management/statistics

Returns basic key management statistics.

**Query Parameters:**
- `startDate` (optional): ISO date string, e.g., `2024-01-01`
- `endDate` (optional): ISO date string, e.g., `2024-12-31`
- `operation` (optional): Filter by operation type (GENERATE, SIGN, ACCESS, etc.)

**Example Request:**
```bash
GET /internal/key-management/statistics?startDate=2024-01-01&endDate=2024-12-31
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "totalKeysGenerated": 150,
    "totalSigningOperations": 3200,
    "totalValidations": 45,
    "totalFailures": 3,
    "keysByType": {
      "STELLAR_ED25519": 150
    },
    "operationsByType": {
      "GENERATE": 150,
      "SIGN": 3200,
      "ACCESS": 45
    },
    "successRate": 99.9,
    "lastOperation": "2024-06-02T10:30:00.000Z",
    "periodStart": "2024-01-01T00:00:00.000Z",
    "periodEnd": "2024-12-31T23:59:59.999Z"
  }
}
```

### GET /internal/key-management/statistics/detailed

Returns detailed statistics with operation metrics and optional time series.

**Query Parameters:**
- `startDate` (optional): ISO date string
- `endDate` (optional): ISO date string
- `operation` (optional): Filter by operation type
- `includeTimeSeries` (optional): Set to `true` to include hourly time series data

**Example Request:**
```bash
GET /internal/key-management/statistics/detailed?includeTimeSeries=true
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "totalKeysGenerated": 150,
    "totalSigningOperations": 3200,
    "totalValidations": 45,
    "totalFailures": 3,
    "keysByType": {
      "STELLAR_ED25519": 150
    },
    "operationsByType": {
      "GENERATE": 150,
      "SIGN": 3200,
      "ACCESS": 45
    },
    "successRate": 99.9,
    "lastOperation": "2024-06-02T10:30:00.000Z",
    "periodStart": "2024-01-01T00:00:00.000Z",
    "periodEnd": "2024-12-31T23:59:59.999Z",
    "operationMetrics": [
      {
        "operation": "GENERATE",
        "count": 150,
        "successCount": 150,
        "failureCount": 0,
        "successRate": 100
      },
      {
        "operation": "SIGN",
        "count": 3200,
        "successCount": 3198,
        "failureCount": 2,
        "successRate": 99.94
      },
      {
        "operation": "ACCESS",
        "count": 45,
        "successCount": 44,
        "failureCount": 1,
        "successRate": 97.78
      }
    ],
    "recentOperations": [
      {
        "operation": "SIGN",
        "timestamp": "2024-06-02T10:30:00.000Z",
        "success": true,
        "keyType": "STELLAR_ED25519"
      },
      {
        "operation": "GENERATE",
        "timestamp": "2024-06-02T10:25:00.000Z",
        "success": true,
        "keyType": "STELLAR_ED25519"
      }
    ],
    "timeSeries": [
      {
        "timestamp": "2024-06-02T10:00:00.000Z",
        "count": 15,
        "operation": "GENERATE"
      },
      {
        "timestamp": "2024-06-02T10:00:00.000Z",
        "count": 120,
        "operation": "SIGN"
      },
      {
        "timestamp": "2024-06-02T11:00:00.000Z",
        "count": 8,
        "operation": "GENERATE"
      }
    ]
  }
}
```

## Programmatic Usage

### Get Basic Statistics

```typescript
import { KeyManagementService } from '../key-management/key-management.service';

constructor(
  private keyManagementService: KeyManagementService,
) {}

async getStats() {
  // Get all-time statistics
  const stats = this.keyManagementService.getStatistics();
  
  console.log(`Keys generated: ${stats.totalKeysGenerated}`);
  console.log(`Success rate: ${stats.successRate}%`);
  console.log(`Last operation: ${stats.lastOperation}`);
  
  return stats;
}
```

### Get Statistics for Date Range

```typescript
async getMonthlyStats() {
  const startDate = new Date('2024-06-01');
  const endDate = new Date('2024-06-30');
  
  const stats = this.keyManagementService.getStatistics({
    startDate,
    endDate,
  });
  
  console.log(`Keys in June: ${stats.totalKeysGenerated}`);
  return stats;
}
```

### Get Statistics by Operation Type

```typescript
async getGenerationStats() {
  const stats = this.keyManagementService.getStatistics({
    operation: 'GENERATE',
  });
  
  console.log(`Total key generations: ${stats.totalKeysGenerated}`);
  return stats;
}
```

### Get Detailed Statistics

```typescript
async getDetailedStats() {
  const stats = this.keyManagementService.getDetailedStatistics({
    includeTimeSeries: true,
  });
  
  // Analyze per-operation metrics
  stats.operationMetrics.forEach((metric) => {
    console.log(`${metric.operation}: ${metric.successRate}% success rate`);
  });
  
  // Check recent operations
  console.log(`Recent operations: ${stats.recentOperations.length}`);
  
  // Analyze time series
  if (stats.timeSeries) {
    console.log(`Time series points: ${stats.timeSeries.length}`);
  }
  
  return stats;
}
```

## Use Cases

### 1. Security Monitoring Dashboard

Build a dashboard showing:
- Key generation trends over time
- Unusual spikes in key operations
- Success/failure rates
- Operation types distribution

```typescript
async buildSecurityDashboard() {
  const last24Hours = {
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(),
    includeTimeSeries: true,
  };
  
  const stats = this.keyManagementService.getDetailedStatistics(last24Hours);
  
  return {
    alerts: stats.totalFailures > 10 ? ['High failure rate'] : [],
    metrics: {
      keysGenerated: stats.totalKeysGenerated,
      signingOps: stats.totalSigningOperations,
      successRate: stats.successRate,
    },
    chart: stats.timeSeries,
  };
}
```

### 2. Capacity Planning

Analyze usage patterns to plan for scaling:

```typescript
async analyzeCapacity() {
  const lastMonth = {
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    endDate: new Date(),
  };
  
  const stats = this.keyManagementService.getStatistics(lastMonth);
  
  const avgKeysPerDay = stats.totalKeysGenerated / 30;
  const avgSignsPerDay = stats.totalSigningOperations / 30;
  
  return {
    avgKeysPerDay,
    avgSignsPerDay,
    projectedMonthly: {
      keys: avgKeysPerDay * 30,
      signs: avgSignsPerDay * 30,
    },
  };
}
```

### 3. Alert System

Set up alerts for anomalies:

```typescript
async checkForAnomalies() {
  const stats = this.keyManagementService.getStatistics();
  
  const alerts = [];
  
  // Alert if success rate drops below 95%
  if (stats.successRate < 95) {
    alerts.push({
      level: 'warning',
      message: `Low success rate: ${stats.successRate}%`,
    });
  }
  
  // Alert if too many failures
  if (stats.totalFailures > 100) {
    alerts.push({
      level: 'critical',
      message: `High failure count: ${stats.totalFailures}`,
    });
  }
  
  return alerts;
}
```

### 4. Compliance Reporting

Generate reports for security audits:

```typescript
async generateComplianceReport(year: number) {
  const startDate = new Date(`${year}-01-01`);
  const endDate = new Date(`${year}-12-31`);
  
  const stats = this.keyManagementService.getDetailedStatistics({
    startDate,
    endDate,
  });
  
  return {
    period: `${year}`,
    summary: {
      totalKeys: stats.totalKeysGenerated,
      totalOperations: Object.values(stats.operationsByType).reduce(
        (sum, count) => sum + count,
        0,
      ),
      securityIncidents: stats.totalFailures,
      overallSuccessRate: stats.successRate,
    },
    operationBreakdown: stats.operationMetrics,
    keyTypes: stats.keysByType,
  };
}
```

### 5. Performance Tracking

Monitor key operation performance:

```typescript
async trackPerformance() {
  const stats = this.keyManagementService.getDetailedStatistics();
  
  // Check if any operation type has low success rate
  const problematicOps = stats.operationMetrics.filter(
    (metric) => metric.successRate < 98,
  );
  
  if (problematicOps.length > 0) {
    console.warn('Operations with low success rate:', problematicOps);
  }
  
  // Monitor recent failures
  const recentFailures = stats.recentOperations.filter((op) => !op.success);
  
  return {
    healthy: problematicOps.length === 0,
    recentFailures: recentFailures.length,
    metrics: stats.operationMetrics,
  };
}
```

## Testing

### Unit Tests

```typescript
import { KeyManagementService } from './key-management.service';

describe('Statistics', () => {
  let service: KeyManagementService;
  
  beforeEach(() => {
    // Setup service
    service.resetStatistics();
  });
  
  it('should track key generations', async () => {
    await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
    await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
    
    const stats = service.getStatistics();
    expect(stats.totalKeysGenerated).toBe(2);
  });
});
```

### Integration Tests

See `src/key-management/key-management-statistics.spec.ts` for comprehensive test coverage.

## Performance Considerations

### Memory Usage

Statistics are stored in memory (in the audit log). By default:
- Maximum 1000 audit entries are kept
- Older entries are automatically pruned
- Each entry is ~500 bytes
- Total memory: ~500KB maximum

### Query Performance

- Basic statistics: O(n) where n = filtered audit log entries
- Detailed statistics: O(n) for metrics + O(n log n) for time series
- Time series generation: Groups by hour, suitable for short-to-medium term analysis

### Recommendations

For production:
1. **Export audit logs periodically** to external storage (database, S3, etc.)
2. **Reset in-memory statistics** after export to free memory
3. **Use caching** for frequently requested statistics
4. **Implement sampling** for very high-volume systems

## Future Enhancements

### Planned Features

1. **Persistent Statistics** - Store in database for long-term analysis
2. **Real-time Streaming** - WebSocket endpoint for live statistics
3. **Alerting Integration** - Built-in alert rules and notifications
4. **Export Formats** - CSV, JSON, PDF report generation
5. **Aggregation Periods** - Hourly, daily, weekly, monthly rollups
6. **Comparison Views** - Period-over-period comparisons
7. **Key Lifecycle Tracking** - Track keys from generation to rotation to archival

## Security Notes

### Internal-Only Endpoints

Statistics endpoints are under `/internal/key-management/*` and should:
- **NOT** be exposed to public internet
- Be protected by authentication/authorization
- Only be accessible to admin users or monitoring systems

### Sensitive Data

Statistics do NOT include:
- ❌ Private keys (never stored or logged)
- ❌ Encrypted key material
- ❌ Full transaction data
- ✅ Public keys (safe to log)
- ✅ Operation types and counts
- ✅ Timestamps and success/failure status

### Audit Trail

Statistics complement but don't replace the audit log:
- Audit log: Detailed, per-operation records
- Statistics: Aggregated, analyzed metrics
- Both are needed for comprehensive security monitoring

## References

- [Key Management Module README](../src/key-management/README.md)
- [Statistics Domain Types](../src/key-management/domain/key-statistics.ts)
- [Statistics Tests](../src/key-management/key-management-statistics.spec.ts)
- [Controller Tests](../src/key-management/key-management.controller.spec.ts)

---

**Feature Version**: 1.0.0  
**Added**: 2024-XX-XX  
**Status**: ✅ Complete and tested
