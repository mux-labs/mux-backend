import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { IdempotentUserService } from './idempotent-user.service';
import { UserStatusService } from './user-status.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsModule } from '../common/metrics/metrics.module';

@Module({
  imports: [PrismaModule, MetricsModule],
  controllers: [UsersController],
  providers: [UsersService, IdempotentUserService, UserStatusService],
  exports: [UsersService, IdempotentUserService, UserStatusService],
})
export class UsersModule {}
