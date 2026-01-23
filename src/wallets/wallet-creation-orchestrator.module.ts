import { Module } from '@nestjs/common';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { WalletCreationOrchestratorController } from './wallet-creation-orchestrator.controller';
import { EncryptionModule } from '../encryption/encryption.module';
import { WalletsModule } from './wallets.module';

@Module({
  imports: [EncryptionModule, WalletsModule],
  controllers: [WalletCreationOrchestratorController],
  providers: [WalletCreationOrchestrator],
  exports: [WalletCreationOrchestrator],
})
export class WalletCreationOrchestratorModule {}
