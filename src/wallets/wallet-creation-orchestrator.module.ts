import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { WalletCreationOrchestratorController } from './wallet-creation-orchestrator.controller';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';
import { ApiKeyModule } from '../api-keys/api-key.module';
import {
  UserStatusService,
  USER_STATUS_PORT,
} from '../users/user-status.service';

/**
 * WalletCreationOrchestratorModule
 *
 * Exposes the wallet create-or-get endpoints consumed by the external
 * orchestrator. The controller is deny-by-default: it requires an API key
 * (`ApiKeyGuard`) and is gated behind the `wallet_orchestrator` feature flag
 * (`FeatureFlagGuard`), so a client cannot bypass policy by calling it
 * directly.
 *
 * The orchestrator itself is additionally gated on the account's `UserStatus`
 * via `USER_STATUS_PORT` (#941): a suspended/disabled account can never mint a
 * custody key. The port is backed by `UserStatusService`, whose store is
 * resolved lazily so wiring the module never opens a database connection.
 *
 * `EncryptionService` is deliberately *not* listed as a provider: it is
 * fail-closed on a missing `WALLET_ENCRYPTION_KEY`, and eagerly constructing it
 * here would make the module un-bootable in the offline suites. The
 * orchestrator resolves it lazily on the first mint instead, so a missing key
 * surfaces as a typed keygen failure rather than a boot failure.
 */
@Module({
  imports: [ConfigModule, ApiKeyModule],
  controllers: [WalletCreationOrchestratorController],
  providers: [
    WalletCreationOrchestrator,
    FeatureFlagGuard,
    UserStatusService,
    { provide: USER_STATUS_PORT, useExisting: UserStatusService },
  ],
  exports: [WalletCreationOrchestrator],
})
export class WalletCreationOrchestratorModule {}
