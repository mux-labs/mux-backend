import { Module } from '@nestjs/common';
import { IdempotentUserModule } from './idempotent-user.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';

@Module({
  imports: [IdempotentUserModule],
  controllers: [UsersController],
  providers: [UsersService, PrismaService, MetricsService],
  exports: [UsersService, IdempotentUserModule],
})
export class UsersModule {}
