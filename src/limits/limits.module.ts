import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LimitsService } from './limits.service';
import { LimitsController } from './limits.controller';
import { SpendingLimitsController } from './spending-limits.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RequestContextService } from '../common/request-context/request-context.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [LimitsController, SpendingLimitsController],
  providers: [
    LimitsService,
    RequestContextService,
    FeatureFlagService,
    FeatureFlagGuard,
  ],
  exports: [LimitsService],
})
export class LimitsModule {}
