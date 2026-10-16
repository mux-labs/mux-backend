import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LimitsService } from './limits.service';

@Module({
  imports: [PrismaModule],
  providers: [LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
