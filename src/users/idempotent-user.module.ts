import { Module } from '@nestjs/common';
import { IdempotentUserService } from './idempotent-user.service';
import { IdempotentUserController } from './idempotent-user.controller';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';

@Module({
  controllers: [IdempotentUserController],
  providers: [IdempotentUserService, PrismaService, MetricsService, ApiKeyGuard, ApiKeyService],
  exports: [IdempotentUserService],
})
export class IdempotentUserModule {}
