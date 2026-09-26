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
    ApiKeyModule,
    MaintenanceModule,
    RateLimitModule,
    
    // Feature modules (commented out until dependencies are implemented)
    // PaymentsModule,
    // UsersModule,
    // AuthModule,
  ],
  controllers: [AppController],
  providers: [
    // Register ApiKeyGuard globally so it applies to all routes
    // Public routes can opt-out using @Public() decorator
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AppModule {}