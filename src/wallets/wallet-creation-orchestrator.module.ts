import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { WalletCreationOrchestratorController } from './wallet-creation-orchestrator.controller';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

/**
 * WalletCreationOrchestratorModule
 *
 * Exposes the wallet create-or-get endpoints consumed by the external
 * orchestrator. The controller is deny-by-default: it requires an API key
 * (`ApiKeyGuard`) and is gated behind the `wallet_orchestrator` feature flag
 * (`FeatureFlagGuard`), so a client cannot bypass policy by calling it
 * directly.
 */
@Module({
  imports: [ConfigModule],
  controllers: [WalletCreationOrchestratorController],
  providers: [
    WalletCreationOrchestrator,
    FeatureFlagGuard,
    ApiKeyGuard,
    ApiKeyService,
  ],
  exports: [WalletCreationOrchestrator],
})
export class WalletCreationOrchestratorModule {}
