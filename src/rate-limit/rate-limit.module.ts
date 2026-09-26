import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  RateLimitService,
  RATE_LIMIT_RECORD_STORE,
} from './rate-limit.service';
import { RateLimitCleanupWorker } from './rate-limit-cleanup.worker';
import { DeveloperQuotaGuard } from './developer-quota.guard';

/**
 * RateLimitModule
 *
 * Owns per-developer API quotas and the cleanup of expired `RateLimitRecord`
 * rows.
 *
 * The cleanup worker is an internal implementation detail and is deliberately
 * NOT exported: it is not part of the module's public API surface.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    RateLimitService,
    DeveloperQuotaGuard,
    RateLimitCleanupWorker,
    PrismaService,
    MetricsService,
    // PrismaService structurally satisfies RateLimitRecordStore.
    { provide: RATE_LIMIT_RECORD_STORE, useExisting: PrismaService },
  ],
  exports: [RateLimitService, DeveloperQuotaGuard],
})
export class RateLimitModule {}
