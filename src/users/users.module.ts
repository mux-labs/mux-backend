import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { IdempotentUserService } from './idempotent-user.service';
import { MetricsService } from '../common/metrics/metrics.service';

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
  providers: [UsersService, IdempotentUserService, MetricsService],
  exports: [UsersService, IdempotentUserService],
})
export class UsersModule {}
