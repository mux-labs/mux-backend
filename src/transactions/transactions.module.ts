import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { TransactionsInternalController } from './transactions-internal.controller';
import { TransactionQueryService } from './transaction-query.service';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';
import { HorizonSubmissionService } from './horizon-submission.service';
import { TransactionRetryService } from './transaction-retry.service';
import { TransactionPollingService } from './transaction-polling.service';
import { TransactionExportService } from './transaction-export.service';
import { TransactionExportController } from './transaction-export.controller';
import { FeeBumpService } from './fee-bump.service';
import { SorobanService } from './soroban.service';
import { RelayerFundingService } from './relayer-funding.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BalanceIndexerModule } from '../balance-indexer/balance-indexer.module';
import { WebhookModule } from '../webhooks/webhook.module';
import { WalletsModule } from '../wallets/wallets.module';
import { CacheService } from '../common/cache/cache.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { TransactionMetricsService } from './transaction-metrics.service';
import { TransactionEnvValidatorService } from './transaction-env-validator.service';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';

@Module({
  imports: [PrismaModule, BalanceIndexerModule, WebhookModule, WalletsModule],
  controllers: [
    TransactionsController,
    TransactionsInternalController,
    TransactionExportController,
  ],
  providers: [
    TransactionsService,
    TransactionQueryService,
    StellarTransactionBuildService,
    HorizonSubmissionService,
    FeeBumpService,
    SorobanService,
    RelayerFundingService,
    CacheService,
    FeatureFlagService,
    TransactionMetricsService,
    TransactionEnvValidatorService,
    TransactionPollingService,
    TransactionExportService,
    TenantScopeGuard,
  ],
  exports: [
    TransactionsService,
    TransactionQueryService,
    StellarTransactionBuildService,
    HorizonSubmissionService,
    TransactionPollingService,
    TransactionExportService,
    FeeBumpService,
  ],
})
export class TransactionsModule {}
