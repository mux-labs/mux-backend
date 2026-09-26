import { Module } from '@nestjs/common';
import { FeeSponsorshipService } from './fee-sponsorship.service';
import { FeeSponsorshipController } from './fee-sponsorship.controller';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyModule } from '../api-keys/api-key.module';

@Module({
  // Supplies ApiKeyGuard for the controller's @UseGuards(ApiKeyGuard).
  imports: [ApiKeyModule],
  controllers: [FeeSponsorshipController],
  providers: [FeeSponsorshipService, PrismaService, MetricsService],
  exports: [FeeSponsorshipService],
})
export class FeeSponsorshipModule {}
