import { Module } from '@nestjs/common';
import { ApiKeyModule } from '../api-keys/api-key.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { IdempotentUserService } from './idempotent-user.service';

@Module({
  imports: [ApiKeyModule, MetricsModule],
  providers: [IdempotentUserService],
  exports: [IdempotentUserService],
})
export class IdempotentUserModule {}
