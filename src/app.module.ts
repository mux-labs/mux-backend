import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { FeeSponsorshipModule } from './fee-sponsorship/fee-sponsorship.module';
import { BalanceIndexerModule } from './balance-indexer/balance-indexer.module';
import { KeyManagementModule } from './key-management/key-management.module';
import { SorobanInvokeModule } from './soroban/soroban-invoke.module';
import { EncryptionModule } from './encryption/encryption.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { ApiKeyModule } from './api-keys/api-key.module';
import { MetricsService } from './common/metrics/metrics.service';
import { PrismaService } from './prisma/prisma.service';
import { IsoUtcTimestampInterceptor } from './common/interceptors/request-id.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseSanitizerInterceptor } from './common/interceptors/response-sanitizer.interceptor';

@Module({
  imports: [
    UsersModule,
    WalletsModule,
    FeeSponsorshipModule,
    KeyManagementModule,
    SorobanInvokeModule,
    EncryptionModule,
    IdempotencyModule,
    BalanceIndexerModule,
    // Owns the API-key lifecycle + guard; exports both so every protected
    // surface shares one instance (#942/#943).
    ApiKeyModule,
  ],
  providers: [
    MetricsService,
    PrismaService,
    IsoUtcTimestampInterceptor,
    HttpExceptionFilter,
    ResponseSanitizerInterceptor,
  ],
  exports: [
    UsersModule,
    WalletsModule,
    FeeSponsorshipModule,
    KeyManagementModule,
    SorobanInvokeModule,
    EncryptionModule,
    IdempotencyModule,
    BalanceIndexerModule,
    ApiKeyModule,
  ],
})
export class AppModule {}
