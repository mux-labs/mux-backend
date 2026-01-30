import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { EncryptionModule } from '../encryption/encryption.module';
import { EncryptionService } from 'src/encryption/encryption.service';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';

@Module({
  imports: [EncryptionModule],
  controllers: [WalletsController],
  providers: [WalletsService, WalletCreationOrchestrator, EncryptionService],
  exports: [WalletsService, WalletCreationOrchestrator],
})
export class WalletsModule {}
