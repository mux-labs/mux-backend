import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { ConfigModule } from './config/config.module';
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
import { MaintenanceGuard } from './maintenance/maintenance.guard';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { ApiKeyModule } from './api-keys/api-key.module';
import { ApiKeyGuard } from './api-keys/api-key.guard';
import { KeyManagementModule } from './key-management/key-management.module';
import { BalanceIndexerModule } from './balance-indexer/balance-indexer.module';
import { WebhookModule } from './webhooks/webhook.module';
import { TransactionsModule } from './transactions/transactions.module';
import { HorizonHistoryImportModule } from './horizon-history-import/horizon-history-import.module';
import { DevelopersModule } from './developers/developers.module';
import { ProjectsModule } from './projects/projects.module';
import { HealthModule } from './health/health.module';
import { IdempotentUserModule } from './users/idempotent-user.module';
import { TracingModule } from './tracing/tracing.module';
import { ApiChangelogModule } from './api-changelog/api-changelog.module';
import { BackupModule } from './backup/backup.module';
import { SloModule } from './common/slo/slo.module';
import { LatencySloInterceptor } from './common/slo/latency-slo.interceptor';
import { ResponseSanitizerInterceptor } from './common/interceptors/response-sanitizer.interceptor';

@Module({
  imports: [
    ConfigModule,
    EventEmitterModule.forRoot(),
    MetricsModule,
    TracingModule.forRoot(),
    PrismaModule,
    AuthModule,
    MaintenanceModule,
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
    HorizonHistoryImportModule,
    DevelopersModule,
    ProjectsModule,
    HealthModule,
    IdempotentUserModule,
    TracingModule,
    ApiChangelogModule,
    BackupModule,
    SloModule,
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
      useClass: MaintenanceGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    // Apply latency SLO tracking globally
    {
      provide: APP_INTERCEPTOR,
      useClass: LatencySloInterceptor,
    },
    // #695: Redact sensitive fields (privateKey, encryptedSecret, …) from every
    // HTTP response, not just the orchestration controller.
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseSanitizerInterceptor,
    },
  ],
})
export class AppModule {}
