import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
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
   * Gets balance for a specific wallet and asset
   */
  @Get('wallet/:walletId')
  async getWalletBalance(
    @Param('walletId') walletId: string,
    @Query('assetType') assetType?: string,
    @Query('assetCode') assetCode?: string,
    @Query('assetIssuer') assetIssuer?: string,
  ) {
    if (assetType) {
      // Get specific asset balance
      const asset: Asset = {
        type: (assetType as AssetType) || AssetType.NATIVE,
        code: assetCode,
        issuer: assetIssuer,
      };

      const balance = await this.balanceIndexerService.getBalance(
        walletId,
        asset,
      );
      return balance || { balance: '0', assetType, assetCode, assetIssuer };
    }

    // Get all balances
    const balances = await this.balanceIndexerService.getAllBalances(walletId);
    return { walletId, balances };
  }

  /**
   * Syncs balances from Stellar Horizon
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
   * Reconciles a wallet's balance with on-chain state
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
   * Reconciles all balances (admin only)
   */
  @Post('reconcile-all')
  @HttpCode(HttpStatus.OK)
  async reconcileAllBalances() {
    return await this.balanceIndexerService.reconcileAllBalances();
  }
}
