import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { TransactionQueryService } from './transaction-query.service';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BalanceIndexerModule } from '../balance-indexer/balance-indexer.module';
import { WebhookModule } from '../webhooks/webhook.module';
import { LimitsModule } from '../limits/limits.module';

@Module({
  imports: [PrismaModule, BalanceIndexerModule, WebhookModule, LimitsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionQueryService, StellarTransactionBuildService],
  exports: [TransactionsService, TransactionQueryService, StellarTransactionBuildService],
})
export class TransactionsModule {}

