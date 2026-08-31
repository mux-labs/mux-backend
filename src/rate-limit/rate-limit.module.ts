import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitCleanupWorker } from './rate-limit-cleanup.worker';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule, ConfigModule],
  providers: [RateLimitService, RateLimitGuard, RateLimitCleanupWorker],
  exports: [RateLimitService, RateLimitGuard],
})
export class RateLimitModule {}
