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
   * Gets balance for a specific wallet and asset.
   * Pass assetType query param for a single asset, or omit for all balances.
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
    if (assetType) {
      const asset: Asset = {
        type: (assetType as AssetType) || AssetType.NATIVE,
        code: assetCode,
        issuer: assetIssuer,
      };
      const balance = await this.balanceIndexerService.getBalance(
        walletId,
        asset,
      );
    }

    const balances = await this.balanceIndexerService.getAllBalances(walletId);
    return { walletId, balances };
  }

  /**
   * Manually triggers a balance sync for a single wallet from Stellar Horizon.
   * Useful when a wallet owner reports stale balance data.
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
   * Manually triggers a full balance sync across all active wallets.
   * Admin-only operation. Tracked via BalanceSyncJob records.
   */
  @Post('sync-all')
  @HttpCode(HttpStatus.OK)
  async syncAllWallets() {
    return await this.balanceIndexerService.syncAllWallets();
  }

  /**
   * Reconciles a wallet's indexed balance with on-chain state.
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
   * Reconciles all balances for all active wallets.
   * Admin-only maintenance operation.
   */
  @Post('reconcile-all')
  @HttpCode(HttpStatus.OK)
  async reconcileAllBalances() {
    return await this.balanceIndexerService.reconcileAllBalances();
  }

  /**
   * Syncs balances with retry backoff
   */
  @Post('wallet/:walletId/sync-with-retry')
  @HttpCode(HttpStatus.OK)
  async syncWithRetry(
    @Param('walletId') walletId: string,
    @Body() body: { forceRefresh?: boolean } = {},
  ) {
    return this.balanceIndexerService.syncWalletBalancesWithRetry({
      walletId,
      forceRefresh: body.forceRefresh || false,
    });
  }

  /**
   * Detects stale balances for a wallet
   */
  @Get('wallet/:walletId/stale')
  async detectStaleBalances(@Param('walletId') walletId: string) {
    return this.balanceIndexerService.detectStaleBalances(walletId);
  }

  /**
   * Triggers the scheduled sync manually
   */
  @Post('sync-all')
  @HttpCode(HttpStatus.OK)
  async syncAll() {
    await this.balanceIndexerService.runScheduledSync();
    return { status: 'scheduled sync triggered' };
  }
}
