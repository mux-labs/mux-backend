import { Module } from '@nestjs/common';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { PrismaModule } from '../prisma/prisma.module';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';

@Module({
  imports: [PrismaModule],
  controllers: [SettlementController],
  providers: [
    SettlementService,
    IdempotencyService,
    FeatureFlagService,
  ],
  exports: [SettlementService],
})
export class SettlementModule {}
