import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { FeeSponsorshipModule } from './fee-sponsorship/fee-sponsorship.module';
import { BalanceIndexerModule } from './balance-indexer/balance-indexer.module';
import { KeyManagementModule } from './key-management/key-management.module';
import { ApiKeyGuard } from './api-keys/api-key.guard';
import { ApiKeyService } from './api-keys/api-key.service';
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
    BalanceIndexerModule,
  ],
  providers: [
    ApiKeyGuard,
    ApiKeyService,
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
    BalanceIndexerModule,
  ],
})
export class AppModule {}
