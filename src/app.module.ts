import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { PaymentsModule } from './payments/payments.module';
import { LimitsModule } from './limits/limits.module';
import { RecoveryModule } from './recovery/recovery.module';
import { AuthModule } from './auth/auth.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { ApiKeyModule } from './api-keys/api-key.module';
import { ApiKeyGuard } from './api-keys/api-key.guard';
import { KeyManagementModule } from './key-management/key-management.module';
import { BalanceIndexerModule } from './balance-indexer/balance-indexer.module';
import { WebhookModule } from './webhooks/webhook.module';
import { TransactionsModule } from './transactions/transactions.module';
import { DevelopersModule } from './developers/developers.module';
import { ProjectsModule } from './projects/projects.module';
import { HealthModule } from './health/health.module';
import { IdempotentUserModule } from './users/idempotent-user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    AuthModule,
    RateLimitModule,
    UsersModule,
    WalletsModule,
    PaymentsModule,
    LimitsModule,
    RecoveryModule,
    ApiKeyModule,
    KeyManagementModule,
    BalanceIndexerModule,
    WebhookModule,
    TransactionsModule,
    DevelopersModule,
    ProjectsModule,
    HealthModule,
    IdempotentUserModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Apply API key and rate limiting globally
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
  ],
})
export class AppModule {}
