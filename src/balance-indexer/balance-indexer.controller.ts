import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BalanceIndexerService } from './balance-indexer.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import type {
  BalanceActor,
  BalanceAssetType,
} from './balance-indexer.model';

/**
 * REST surface for Horizon balance reads, sync and reconciliation.
 *
 * Every route is behind `ApiKeyGuard` (deny-by-default: no credentials means
 * no access), and every mutating route additionally goes through the service's
 * `BALANCE_SYNC_ENABLED` kill-switch, so an un-flagged deploy serves reads only.
 *
 * Response bodies carry balances as strings and never include secrets, key
 * material, or Horizon credentials.
 */
@Controller('balances')
export class BalanceIndexerController {
  private readonly logger = new Logger(BalanceIndexerController.name);

  constructor(private readonly balanceIndexer: BalanceIndexerService) {}

  /**
   * GET /v1/balances/wallet/:walletId
   *
   * Cached balances for a wallet. Pass `?assetType=NATIVE` (plus optional
   * `assetCode`/`assetIssuer`) to scope the read to a single asset.
   */
  @Get('wallet/:walletId')
  @UseGuards(ApiKeyGuard)
  async getWalletBalances(
    @Param('walletId') walletId: string,
    @Query('assetType') assetType: BalanceAssetType | undefined,
    @Query('assetCode') assetCode: string | undefined,
    @Query('assetIssuer') assetIssuer: string | undefined,
    @Req() request: any,
  ) {
    const actor = this.actorFrom(request);
    // With no assetType the caller wants the whole set; with one, scope the read.
    if (!assetType) {
      const balances = await this.balanceIndexer.getAllBalances(actor, walletId);
      return { walletId, balances };
    }

    const balance = await this.balanceIndexer.getBalance(actor, walletId, {
      type: assetType,
      code: assetCode,
      issuer: assetIssuer,
    });
    return { walletId, balances: balance ? [balance] : [] };
  }

  /**
   * POST /v1/balances/wallet/:walletId/sync
   *
   * Refresh a wallet's balances from Horizon. Idempotent: a replayed request
   * converges on the same state.
   */
  @Post('wallet/:walletId/sync')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async syncWalletBalances(
    @Param('walletId') walletId: string,
    @Body() body: { forceRefresh?: boolean } = {},
    @Req() request: any,
  ) {
    return this.balanceIndexer.syncWalletBalances(this.actorFrom(request), {
      walletId,
      forceRefresh: body?.forceRefresh === true,
    });
  }

  /**
   * POST /v1/balances/wallet/:walletId/sync-with-retry
   *
   * As `sync`, but retries transient Horizon/DB failures with bounded backoff.
   */
  @Post('wallet/:walletId/sync-with-retry')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async syncWalletBalancesWithRetry(
    @Param('walletId') walletId: string,
    @Body() body: { forceRefresh?: boolean; maxAttempts?: number } = {},
    @Req() request: any,
  ) {
    return this.balanceIndexer.syncWalletBalancesWithRetry(this.actorFrom(request), {
      walletId,
      forceRefresh: body?.forceRefresh === true,
      maxAttempts: body?.maxAttempts,
    });
  }

  /**
   * POST /v1/balances/wallet/:walletId/reconcile
   *
   * Compare one asset of a wallet against its on-chain balance and flag any
   * mismatch. The indexed balance is never overwritten — an operator decides.
   */
  @Post('wallet/:walletId/reconcile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async reconcileBalance(
    @Param('walletId') walletId: string,
    @Body()
    body: {
      assetType: BalanceAssetType;
      assetCode?: string;
      assetIssuer?: string;
    },
    @Req() request: any,
  ) {
    return this.balanceIndexer.reconcileBalance(this.actorFrom(request), walletId, {
      type: body?.assetType,
      code: body?.assetCode,
      issuer: body?.assetIssuer,
    });
  }

  /** POST /v1/balances/reconcile-all — sweep every active wallet. */
  @Post('reconcile-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async reconcileAllBalances(@Req() request: any) {
    return this.balanceIndexer.reconcileAllBalances(this.actorFrom(request));
  }

  /** POST /v1/balances/sync-all — refresh every active wallet. */
  @Post('sync-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async syncAllWallets(@Req() request: any) {
    return this.balanceIndexer.syncAllWallets(this.actorFrom(request));
  }

  /**
   * GET /v1/balances/wallet/:walletId/stale
   *
   * Report balances that have not been refreshed inside the staleness budget.
   */
  @Get('wallet/:walletId/stale')
  @UseGuards(ApiKeyGuard)
  async detectStaleBalances(
    @Param('walletId') walletId: string,
    @Req() request: any,
  ) {
    return this.balanceIndexer.detectStaleBalances(this.actorFrom(request), walletId);
  }

  /**
   * POST /v1/balances/scheduled-sync
   *
   * Manually trigger the scheduled sweep. Returns immediately; per-wallet
   * failures are counted in metrics rather than aborting the run.
   */
  @Post('scheduled-sync')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async runScheduledSync(@Req() request: any) {
    await this.balanceIndexer.runScheduledSync(this.actorFrom(request));
    return { status: 'scheduled sync triggered' };
  }

  /**
   * Builds the actor from the API-key guard's context. The subject is the key's
   * developer's owning user, read from the authenticated key, never from the
   * request body or query, so a caller cannot assert ownership of a wallet.
   */
  private actorFrom(request: any): BalanceActor {
    return {
      subjectId: request.apiKeyContext?.developer?.userId,
      role: 'api-key',
      correlationId:
        request.requestId ?? request.headers?.['x-request-id'] ?? randomUUID(),
    };
  }
}
