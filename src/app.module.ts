import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TerminusModule } from '@nestjs/terminus';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { WalletsModule } from './wallets/wallets.module';
import { KeyManagementModule } from './key-management/key-management.module';
import { SorobanInvokeModule } from './soroban/soroban-invoke.module';
import { EncryptionModule } from './encryption/encryption.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { ErrorCodeCatalogModule } from './common/error-code-catalog/error-code-catalog.module';
import { GracefulShutdownModule } from './common/shutdown/graceful-shutdown.module';
import { ApiKeyModule } from './api-keys/api-key.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { ApiKeyGuard } from './api-keys/api-key.guard';
import { AppController } from './app.controller';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Rate limiting
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),

    // Event emitter for domain events
    EventEmitterModule.forRoot(),

    // Health checks
    TerminusModule,

    // Core modules
    PrismaModule,
    HealthModule,
    WalletsModule,
    KeyManagementModule,
    SorobanInvokeModule,
    EncryptionModule,
    IdempotencyModule,
    BalanceIndexerModule,
    ErrorCodeCatalogModule,
    GracefulShutdownModule,
    ApiKeyModule,
    MaintenanceModule,
    RateLimitModule,
  ],
  controllers: [AppController],
  providers: [
    SorobanInvokeModule,
    EncryptionModule,
    IdempotencyModule,
    BalanceIndexerModule,
    ErrorCodeCatalogModule,
    GracefulShutdownModule,
    ApiKeyModule,
    MaintenanceModule,
    RateLimitModule,
  ],
})
export class AppModule {}