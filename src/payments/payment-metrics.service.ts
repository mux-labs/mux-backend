import { Injectable, Logger } from '@nestjs/common';

export type PaymentOperation = 'create' | 'update' | 'findOne' | 'findAll';
export type PaymentOutcome = 'success' | 'failure' | 'idempotent';

export interface PaymentMetric {
  operation: PaymentOperation;
  outcome: PaymentOutcome;
  durationMs: number;
  /** Never include PII, wallet addresses, or private keys here. */
  failureReason?: string;
  currency?: string;
}

export interface PaymentMetricsSnapshot {
  totalOperations: number;
  outcomeBreakdown: Record<PaymentOutcome, number>;
  operationBreakdown: Record<PaymentOperation, number>;
  averageDurationMs: number;
  p95DurationMs: number;
}

/** Structured-log metrics seam for the Payments domain. */
@Injectable()
export class PaymentMetricsService {
  private readonly logger = new Logger(PaymentMetricsService.name);
  private static readonly MAX_SAMPLES = 1_000;
  private total = 0;
  private readonly outcomes: Record<PaymentOutcome, number> = { success: 0, failure: 0, idempotent: 0 };
  private readonly operations: Record<PaymentOperation, number> = { create: 0, update: 0, findOne: 0, findAll: 0 };
  private readonly samples: number[] = [];
  private sampleIdx = 0;

  record(m: PaymentMetric): void {
    this.total++;
    this.outcomes[m.outcome]++;
    this.operations[m.operation]++;
    if (this.samples.length < PaymentMetricsService.MAX_SAMPLES) {
      this.samples.push(m.durationMs);
    } else {
      this.samples[this.sampleIdx % PaymentMetricsService.MAX_SAMPLES] = m.durationMs;
    }
    this.sampleIdx++;
    const fields = [`metric=payment_operation`, `op=${m.operation}`, `outcome=${m.outcome}`, `ms=${Math.max(0, Math.round(m.durationMs))}`];
    if (m.failureReason) fields.push(`reason=${m.failureReason}`);
    if (m.currency) fields.push(`currency=${m.currency}`);
    this.logger.log(`[payment-metrics] ${fields.join(' ')}`);
  }

  getSnapshot(): PaymentMetricsSnapshot {
    return {
      totalOperations: this.total,
      outcomeBreakdown: { ...this.outcomes },
      operationBreakdown: { ...this.operations },
      averageDurationMs: this.avg(),
      p95DurationMs: this.pct(95),
    };
  }

  reset(): void {
    this.total = 0;
    for (const k of Object.keys(this.outcomes) as PaymentOutcome[]) this.outcomes[k] = 0;
    for (const k of Object.keys(this.operations) as PaymentOperation[]) this.operations[k] = 0;
    this.samples.length = 0;
    this.sampleIdx = 0;
  }

  private avg(): number {
    if (!this.samples.length) return 0;
    return Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length);
  }

  private pct(p: number): number {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
  }
}
