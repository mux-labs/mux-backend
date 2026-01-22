import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { WalletCreationOrchestrator } from './orchestrator/wallet-creation.orchestrator';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [WalletsController],
  providers: [WalletsService, WalletCreationOrchestrator],
  exports: [WalletsService, WalletCreationOrchestrator],
})
export class WalletsModule {}
