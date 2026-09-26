import { Module } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [RateLimitGuard],
  exports: [RateLimitGuard],
})
export class RateLimitModule {}