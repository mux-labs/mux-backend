import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './prisma/prisma.module';
import { MetricsModule } from './metrics/metrics.module';
import { TracingModule } from './tracing/tracing.module';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { IdempotentUserModule } from './users/idempotent-user.module';
import { WalletsModule } from './wallets/wallets.module';
import { WalletCreationOrchestratorModule } from './wallets/wallet-creation-orchestrator.module';
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
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { ResponseRedactionInterceptor } from './common/interceptors/response-redaction.interceptor';
import { SettlementModule } from './settlement/settlement.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
    }),
    EventEmitterModule.forRoot(),
    MetricsModule,
    TracingModule.forRoot(),
    PrismaModule,
    AuthModule,
    RateLimitModule,
    UsersModule,
    IdempotentUserModule,
    WalletsModule,
    WalletCreationOrchestratorModule,
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
    SettlementModule,
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
    // Global interceptors
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestIdInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseRedactionInterceptor,
    },
  ],
})
export class AppModule {}
