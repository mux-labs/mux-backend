import { Module } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { LimitsController } from './limits.controller';

@Module({
  controllers: [LimitsController],
  providers: [LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
