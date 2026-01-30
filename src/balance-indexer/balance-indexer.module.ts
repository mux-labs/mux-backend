import { Module } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { BalanceIndexerController } from './balance-indexer.controller';
import { StellarHorizonService } from './stellar-horizon.service';

@Module({
  controllers: [BalanceIndexerController],
  providers: [BalanceIndexerService, StellarHorizonService],
  exports: [BalanceIndexerService],
})
export class BalanceIndexerModule {}
