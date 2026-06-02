import { Module } from '@nestjs/common';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { WalletCreationOrchestratorController } from './wallet-creation-orchestrator.controller';
import { EncryptionModule } from '../encryption/encryption.module';
import { WalletsModule } from './wallets.module';
import { UsersModule } from '../users/users.module';
import { IdempotentUserModule } from '../users/idempotent-user.module';
import { IdempotencyService } from '../common/idempotency/idempotency.service';

@Module({
  imports: [EncryptionModule, WalletsModule, UsersModule, IdempotentUserModule],
  controllers: [WalletCreationOrchestratorController],
  providers: [WalletCreationOrchestrator, IdempotencyService],
  exports: [WalletCreationOrchestrator],
})
export class WalletCreationOrchestratorModule {}
