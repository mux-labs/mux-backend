import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionQueryService } from './transaction-query.service';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';

@Module({
  providers: [
    TransactionsService,
    TransactionQueryService,
    StellarTransactionBuildService,
  ],
  exports: [TransactionsService, TransactionQueryService, StellarTransactionBuildService],
})
export class TransactionsModule {}
