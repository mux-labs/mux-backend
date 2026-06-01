import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, StellarTransactionBuildService],
  exports: [TransactionsService, StellarTransactionBuildService],
})
export class TransactionsModule {}
