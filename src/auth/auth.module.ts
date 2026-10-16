import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsModule } from '../common/metrics/metrics.module';
import { AuthMetricsService } from './auth-metrics.service';

@Module({
  imports: [PrismaModule, MetricsModule],
  providers: [AuthMetricsService],
  exports: [AuthMetricsService],
})
export class AuthModule {}
