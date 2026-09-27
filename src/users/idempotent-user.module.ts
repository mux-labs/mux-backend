import { Module } from '@nestjs/common';
import { IdempotentUserService } from './idempotent-user.service';
import { IdempotentUserController } from './idempotent-user.controller';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyModule } from '../api-keys/api-key.module';

@Module({
  // API-key auth is provided by ApiKeyModule so revocation is immediate across
  // every surface that uses the guard (#942/#943).
  imports: [ApiKeyModule],
  controllers: [IdempotentUserController],
  providers: [IdempotentUserService, PrismaService, MetricsService],
  exports: [IdempotentUserService],
})
export class IdempotentUserModule {}
