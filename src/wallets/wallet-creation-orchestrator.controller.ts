import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  ConflictException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import {
  WalletCreationOrchestrator,
  type CreateWalletOrchestratorRequest,
  type WalletOrchestrationResult,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork } from './domain/wallet.model';
import { ApiKeyGuard } from '../auth/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';

@Controller('wallets/orchestration')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class WalletCreationOrchestratorController {
  constructor(
    private readonly walletCreationOrchestrator: WalletCreationOrchestrator,
  ) {}

  @Post('create')
  @HttpCode(HttpStatus.OK)
  @SensitiveEndpoint()
  async createWallet(
    @Body() createWalletRequest: CreateWalletOrchestratorRequest,
  ): Promise<WalletOrchestrationResult> {
    try {
      return await this.walletCreationOrchestrator.createWallet(
        createWalletRequest,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      if (error instanceof ConflictException) {
        throw error;
      }
      throw new Error('Wallet creation orchestration failed');
    }
  }

  @Get('user/:userId/:network')
  async getWalletByUser(
    @Param('userId') userId: string,
    @Param('network') network: WalletNetwork,
  ) {
    const wallet = await this.walletCreationOrchestrator.getWalletByUser(
      userId,
      network,
    );

    if (!wallet) {
      throw new NotFoundException(
        `Wallet not found for user ${userId} on ${network}`,
      );
    }

    return wallet;
  }

  @Get('validate/:userId/:network')
  async validateUserCanCreateWallet(
    @Param('userId') userId: string,
    @Param('network') network: WalletNetwork,
  ) {
    const canCreate =
      await this.walletCreationOrchestrator.validateUserCanCreateWallet(
        userId,
        network,
      );
    return { canCreate };
  }
}
