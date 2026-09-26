import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { WalletService } from './wallet.service';
import { WalletCreationOrchestratorModule } from './wallet-creation-orchestrator.module';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { KeyRotationService, WALLET_KEY_STORE } from './key-rotation.service';
import { KeyRotationController } from './key-rotation.controller';
import { ApiKeyModule } from '../api-keys/api-key.module';

@Module({
  // ApiKeyModule owns ApiKeyService/ApiKeyGuard so revocation (#942) and
  // network scoping (#943) are enforced identically on every wallet route.
  // WalletCreationOrchestratorModule is imported (not listed as a provider —
  // a module is not a provider) because WalletsController injects
  // WalletCreationOrchestrator from it.
  imports: [ApiKeyModule, WalletCreationOrchestratorModule],
  controllers: [WalletsController, KeyRotationController],
  providers: [
    WalletsService,
    WalletService,
    PrismaService,
    MetricsService,
    KeyRotationService,
    // PrismaService satisfies WalletKeyStore structurally.
    { provide: WALLET_KEY_STORE, useExisting: PrismaService },
  ],
  exports: [WalletsService, WalletService, KeyRotationService],
})
export class WalletsModule {}
