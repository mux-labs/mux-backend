import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { WalletSigningService } from './wallet-signing.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletCreationOrchestrator } from './orchestrator/wallet-creation.orchestrator';
import { EncryptionModule } from '../encryption/encryption.module';

@Module({
  imports: [PrismaModule, EncryptionModule],
  controllers: [WalletsController],
  providers: [WalletsService, WalletSigningService, WalletCreationOrchestrator],
  exports: [WalletsService, WalletSigningService, WalletCreationOrchestrator],
})
export class WalletsModule {}
