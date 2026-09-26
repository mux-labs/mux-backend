import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { WalletService } from './wallet.service';
import { WalletCreationOrchestratorModule } from './wallet-creation-orchestrator.module';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { KeyRotationService, WALLET_KEY_STORE } from './key-rotation.service';
import { KeyRotationController } from './key-rotation.controller';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';

@Module({
  controllers: [WalletsController, KeyRotationController],
  providers: [
    WalletsService,
    WalletService,
    WalletCreationOrchestratorModule,
    PrismaService,
    MetricsService,
    KeyRotationService,
    // PrismaService satisfies WalletKeyStore structurally.
    { provide: WALLET_KEY_STORE, useExisting: PrismaService },
    ApiKeyGuard,
    ApiKeyService,
  ],
  exports: [WalletsService, WalletService, KeyRotationService],
})
export class WalletsModule {}
