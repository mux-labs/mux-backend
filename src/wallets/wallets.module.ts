import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { EncryptionModule } from '../encryption/encryption.module';
import { EncryptionService } from 'src/encryption/encryption.service';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { ApiKeyModule } from '../api-keys/api-key.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { KeyManagementModule } from '../key-management/key-management.module';

@Module({
  imports: [EncryptionModule, ApiKeyModule, RateLimitModule, KeyManagementModule],
  controllers: [WalletsController],
  providers: [WalletsService, WalletCreationOrchestrator, EncryptionService],
  exports: [WalletsService, WalletCreationOrchestrator],
})
export class WalletsModule {}
