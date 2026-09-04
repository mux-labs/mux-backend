import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric('payments_created_total')
    private readonly paymentsCreatedCounter: Counter,
    @InjectMetric('payments_failed_total')
    private readonly paymentsFailedCounter: Counter,
    @InjectMetric('payment_processing_duration_seconds')
    private readonly paymentProcessingHistogram: Histogram,
    @InjectMetric('limit_exceeded_total')
    private readonly limitExceededCounter: Counter,
    @InjectMetric('limit_checks_total')
    private readonly limitChecksCounter: Counter,
    @InjectMetric('payment_idempotency_hits_total')
    private readonly paymentIdempotencyHitsCounter: Counter,
  ) {}

  incrementPaymentsCreated(): void {
    this.paymentsCreatedCounter.inc();
  }

  incrementPaymentsFailed(reason: string): void {
    this.paymentsFailedCounter.labels(reason).inc();
  }

  recordPaymentProcessingDuration(durationMs: number): void {
    this.paymentProcessingHistogram.observe(durationMs / 1000);
  }

  incrementLimitExceeded(limitType: string): void {
    this.limitExceededCounter.labels(limitType).inc();
  }

  incrementLimitChecks(result: 'allowed' | 'denied'): void {
    this.limitChecksCounter.labels(result).inc();
  }

  incrementPaymentIdempotencyHit(): void {
    this.paymentIdempotencyHitsCounter.inc();
  }
}
