import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { WalletService } from './wallet.service';
import { WalletCreationOrchestratorModule } from './wallet-creation-orchestrator.module';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';

@Module({
  controllers: [WalletsController],
  providers: [
    WalletsService,
    WalletService,
    WalletCreationOrchestratorModule,
    PrismaService,
    MetricsService,
  ],
  exports: [WalletsService, WalletService],
})
export class WalletsModule {}
