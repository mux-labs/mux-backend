import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { StellarSigningService } from './stellar-signing.service';
import { HorizonSubmissionService } from './horizon-submission.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TransactionsController],
  providers: [
    TransactionsService,
    StellarSigningService,
    HorizonSubmissionService,
  ],
  exports: [TransactionsService, StellarSigningService, HorizonSubmissionService],
})
export class TransactionsModule {}
