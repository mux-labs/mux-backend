import { Module } from '@nestjs/common';
import { IdempotentUserModule } from './idempotent-user.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UserStatusService, USER_STATUS_PORT } from './user-status.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyModule } from '../api-keys/api-key.module';

@Module({
  imports: [IdempotentUserModule, ApiKeyModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserStatusService,
    // Other modules inject the port token, never the concrete service, so the
    // enforcement point stays substitutable in tests (#941).
    { provide: USER_STATUS_PORT, useExisting: UserStatusService },
    PrismaService,
    MetricsService,
  ],
  exports: [
    UsersService,
    UserStatusService,
    USER_STATUS_PORT,
    IdempotentUserModule,
  ],
})
export class UsersModule {}
