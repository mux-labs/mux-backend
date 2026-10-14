import { Module } from '@nestjs/common';
import { IdempotentUserModule } from './idempotent-user.module';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';

@Module({
  imports: [IdempotentUserModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    PrismaService,
    MetricsService,
    ApiKeyGuard,
    ApiKeyService,
  ],
  exports: [UsersService, IdempotentUserModule],
})
export class UsersModule {}
