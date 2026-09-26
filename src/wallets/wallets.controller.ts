import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Param,
  Query,
} from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { WalletNetwork } from './domain/wallet.model';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly orchestrator: WalletCreationOrchestrator,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ApiKeyGuard)
  async createWallet(
    @Body() body: {
      userId: string;
      network: WalletNetwork;
      idempotencyKey?: string;
    },
  ) {
    const result = await this.orchestrator.createWallet(
      body.userId,
      body.network,
      body.idempotencyKey ?? '',
    );
    return result;
  }

  @Get()
  @UseGuards(ApiKeyGuard)
  async listWallets(
    @Query('userId') userId?: string,
    @Query('network') network?: WalletNetwork,
  ) {
    return this.walletsService.findAll(userId, network);
  }

  @Get(':id')
  @UseGuards(ApiKeyGuard)
  async getWallet(@Param('id') id: string) {
    return this.walletsService.getWalletStatus(id);
  }
}
