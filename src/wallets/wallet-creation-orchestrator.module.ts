import { Module } from '@nestjs/common';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';

@Module({
  providers: [WalletCreationOrchestrator],
  exports: [WalletCreationOrchestrator],
})
export class WalletCreationOrchestratorModule {}
