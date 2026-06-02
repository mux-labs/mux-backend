import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BalanceIndexerService } from './balance-indexer.service';
import { BalanceIndexerController } from './balance-indexer.controller';
import { StellarHorizonService } from './stellar-horizon.service';

@Module({
  imports: [ConfigModule],
  controllers: [BalanceIndexerController],
  providers: [BalanceIndexerService, StellarHorizonService],
  exports: [BalanceIndexerService],
})
export class BalanceIndexerModule {}
