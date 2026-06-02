import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BalanceIndexerService } from './balance-indexer.service';
import { BalanceIndexerController } from './balance-indexer.controller';
import { StellarHorizonService } from './stellar-horizon.service';
import { WebhookModule } from '../webhooks/webhook.module';

@Module({
  imports: [WebhookModule],
  controllers: [BalanceIndexerController],
  providers: [BalanceIndexerService, StellarHorizonService],
  exports: [BalanceIndexerService],
})
export class BalanceIndexerModule {}
