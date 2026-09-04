import { Module } from '@nestjs/common';
import { PrometheusModule, makeCounterProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [PrometheusModule.register()],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    makeCounterProvider({
      name: 'payments_created_total',
      help: 'Total number of payments created',
    }),
    makeCounterProvider({
      name: 'payments_failed_total',
      help: 'Total number of payments that failed',
      labelNames: ['failure_reason'],
    }),
    makeHistogramProvider({
      name: 'payment_processing_duration_seconds',
      help: 'Payment processing duration in seconds',
      buckets: [0.1, 0.5, 1, 2, 5, 10],
    }),
    makeCounterProvider({
      name: 'limit_exceeded_total',
      help: 'Total number of times a limit was exceeded',
      labelNames: ['limit_type'],
    }),
    makeCounterProvider({
      name: 'limit_checks_total',
      help: 'Total number of limit checks performed',
      labelNames: ['result'],
    }),
    makeCounterProvider({
      name: 'payment_idempotency_hits_total',
      help: 'Total number of payment create requests deduplicated via idempotency key',
    }),
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
