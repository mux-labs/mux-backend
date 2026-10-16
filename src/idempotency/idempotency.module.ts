import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsService } from '../metrics/metrics.service';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';
import { IDEMPOTENCY_RECORD_STORE } from './idempotency.constants';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    IdempotencyService,
    IdempotencyCleanupWorker,
    MetricsService,
    { provide: IDEMPOTENCY_RECORD_STORE, useExisting: PrismaService },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
