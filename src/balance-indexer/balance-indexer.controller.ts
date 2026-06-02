import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  BalanceIndexerService,
  SyncBalancesRequest,
} from './balance-indexer.service';
import { Asset, AssetType } from './domain/balance.model';

@Controller('balances')
export class BalanceIndexerController {
  constructor(private readonly balanceIndexerService: BalanceIndexerService) {}

  /**
   * GET /balances/wallet/:walletId
   * Returns all indexed balances for a wallet.
   */
  @Get('wallet/:walletId')
  async getWalletBalances(@Param('walletId') walletId: string) {
    const balances = await this.balanceIndexerService.getAllBalances(walletId);
    return { walletId, balances };
  }

  /**
   * GET /balances/wallet/:walletId/asset
   * Returns a specific asset balance for a wallet.
   * Query params: assetType (required), assetCode, assetIssuer
   */
  @Get('wallet/:walletId/asset')
  async getWalletAssetBalance(
    @Param('walletId') walletId: string,
    @Query('assetType') assetType: string,
    @Query('assetCode') assetCode?: string,
    @Query('assetIssuer') assetIssuer?: string,
  ) {
    const asset: Asset = {
      type: (assetType as AssetType) || AssetType.NATIVE,
      code: assetCode,
      issuer: assetIssuer,
    };

    const balance = await this.balanceIndexerService.getBalance(walletId, asset);
    if (!balance) {
      throw new NotFoundException(
        `No balance found for wallet ${walletId} and asset ${assetType}`,
      );
    }
    return balance;
  }

  /**
   * POST /balances/wallet/:walletId/sync
   * Syncs balances from Stellar Horizon for a specific wallet.
   */
  @Post('wallet/:walletId/sync')
  @HttpCode(HttpStatus.OK)
  async syncWalletBalances(
    @Param('walletId') walletId: string,
    @Body() body: { forceRefresh?: boolean } = {},
  ) {
    const request: SyncBalancesRequest = {
      walletId,
      forceRefresh: body.forceRefresh || false,
    };

    return await this.balanceIndexerService.syncWalletBalances(request);
  }

  /**
   * POST /balances/wallet/:walletId/reconcile
   * Reconciles a wallet's balance with on-chain state.
   */
  @Post('wallet/:walletId/reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcileWalletBalance(
    @Param('walletId') walletId: string,
    @Body()
    body: { assetType: string; assetCode?: string; assetIssuer?: string },
  ) {
    const asset: Asset = {
      type: body.assetType as AssetType,
      code: body.assetCode,
      issuer: body.assetIssuer,
    };

    return await this.balanceIndexerService.reconcileBalance(walletId, asset);
  }

  /**
   * POST /balances/reconcile-all
   * Reconciles all balances (admin operation).
   */
  @Post('reconcile-all')
  @HttpCode(HttpStatus.OK)
  async reconcileAllBalances() {
    return await this.balanceIndexerService.reconcileAllBalances();
  }
}
