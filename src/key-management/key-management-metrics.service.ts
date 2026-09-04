import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Histogram } from 'prom-client';

@Injectable()
export class KeyManagementMetricsService {
  constructor(
    @InjectMetric('key_mgmt_operations_total')
    private readonly operationsCounter: Counter,
    @InjectMetric('key_mgmt_operation_duration_ms')
    private readonly durationHistogram: Histogram,
  ) {}

  incrementKeyOperations(operation: string, status: 'success' | 'failure'): void {
    this.operationsCounter.labels(operation, status).inc();
  }

  recordKeyOperationDuration(operation: string, durationMs: number): void {
    this.durationHistogram.labels(operation).observe(durationMs);
  }
}
