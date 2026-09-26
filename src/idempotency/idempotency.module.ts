import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  IdempotencyService,
  IDEMPOTENCY_RECORD_STORE,
} from './idempotency.service';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';

/**
 * IdempotencyModule
 *
 * Owns the lifecycle of `IdempotencyRecord` rows, including TTL cleanup of
 * expired records. See docs/IDEMPOTENCY-TTL.md for the operational contract.
 *
 * The cleanup worker is an internal implementation detail and is deliberately
 * NOT exported: it is not part of the module's public API surface.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    IdempotencyService,
    IdempotencyCleanupWorker,
    PrismaService,
    MetricsService,
    // PrismaService structurally satisfies IdempotencyRecordStore.
    { provide: IDEMPOTENCY_RECORD_STORE, useExisting: PrismaService },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
