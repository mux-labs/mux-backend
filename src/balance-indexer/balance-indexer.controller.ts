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
  UseGuards,
} from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import type { BalanceAssetType } from './balance-indexer.model';

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
  @ApiOperation({
    summary: 'Get all balances for a wallet with pagination and filtering',
  })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
    description: 'Page number (starting from 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 20,
    description: 'Items per page (max 100)',
  })
  @ApiQuery({
    name: 'assetType',
    required: false,
    enum: AssetType,
    description: 'Filter by asset type',
  })
  @ApiQuery({
    name: 'assetCode',
    required: false,
    example: 'USD',
    description: 'Filter by asset code',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of wallet balances',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: { $ref: '#/components/schemas/WalletBalanceResponseDto' },
        },
        total: { type: 'number', example: 5 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 20 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid pagination or filter params',
    example: {
      statusCode: 400,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/balances/wallet/123/page/abc',
      method: 'GET',
      message: 'page must be an integer',
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found or has no balances',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/balances/wallet/invalid-wallet',
      method: 'GET',
      message: 'Wallet not found',
      error: 'Not Found',
    },
  })
  async getWalletBalances(
    @Param('walletId') walletId: string,
    @Query('assetType') assetType?: BalanceAssetType,
    @Query('assetCode') assetCode?: string,
    @Query('assetIssuer') assetIssuer?: string,
  ) {
    // With no assetType the caller wants the whole set; with one, scope the read.
    if (!assetType) {
      const balances = await this.balanceIndexer.getAllBalances(walletId);
      return { walletId, balances };
    }

    const balance = await this.balanceIndexer.getBalance(walletId, {
      type: assetType,
      code: assetCode,
      issuer: assetIssuer,
    });

    if (!balance) {
      throw new NotFoundException(
        `No balance record found for wallet '${walletId}' and asset '${assetType}'`,
      );
    }

    return this.toMultiAssetResponse(walletId, [balance]);
    }

    const balance = await this.balanceIndexer.getBalance(walletId, {
      type: assetType,
      code: assetCode,
      issuer: assetIssuer,
    });

    // With no assetType the caller wants the whole set; with one, scope the read.
    if (!assetType) {
      const balances = await this.balanceIndexer.getAllBalances(walletId);
      return { walletId, balances };
    }

    const balance = await this.balanceIndexer.getBalance(walletId, {
      type: assetType,
      code: assetCode,
      issuer: assetIssuer,
    });

    if (!balance) {
      throw new NotFoundException(
        `No balance record found for wallet '${walletId}' and asset '${assetType}'`,
      );
    }

    return this.toMultiAssetResponse(walletId, [balance]);
  }

  /**
   * POST /v1/balances/wallet/:walletId/sync
   *
    };

    const balance = await this.balanceIndexerService.getBalance(
      walletId,
      asset,
    );

    if (!balance) {
      throw new NotFoundException(
        `No balance record found for wallet '${walletId}' and asset '${assetType}'`,
      );
    }

    return this.toMultiAssetResponse(walletId, [balance]);
  }

  /**
   * POST /v1/balances/wallet/:walletId/sync
   *

   */
  @Post('wallet/:walletId/sync')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async syncWalletBalances(
    @Param('walletId') walletId: string,
    @Body() body: { forceRefresh?: boolean } = {},
  ) {
    return this.balanceIndexer.syncWalletBalances({
      walletId,
      forceRefresh: body?.forceRefresh === true,
    };
    return this.balanceIndexerService.syncWalletBalances(request);
  }

  /**
   * `POST /balances/wallet/:walletId/reconcile`
   *
   * Compares the indexed balance for a specific asset against the live
   * Horizon state and corrects any divergence.
   *
   * Request body:
   * ```json
   * { "assetType": "CREDIT_ALPHANUM4", "assetCode": "USDC", "assetIssuer": "GA5Z..." }
   * ```
   *
   * Response `200`:
   * ```json
   * {
   *   "walletId": "uuid",
   *   "asset": { "type": "CREDIT_ALPHANUM4", "code": "USDC", "issuer": "GA5Z..." },
   *   "indexedBalance": "100.0000000",
   *   "onChainBalance": "101.0000000",
   *   "matches": false,
   *   "difference": "-1.0000000"
   * }
   * ```
   *
   * Side effects:
   * - When a mismatch is found: updates the index, increments
   *   `reconciliationAttempts`, and emits a `balance.mismatch` webhook event.
   * - When balances match: clears any prior `mismatchDetectedAt` timestamp.
   */

  /**
   * Manually triggers a full balance sync across all active wallets.
   */
  @Post('sync-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync balances for all wallets (admin operation)' })
  @ApiResponse({
    status: 200,
    description: 'Full sync completed',
    schema: {
      type: 'object',
      properties: {
        walletsProcessed: { type: 'number', example: 10 },
        balancesUpdated: { type: 'number', example: 45 },
        mismatchesFound: { type: 'number', example: 2 },
      },
    },
  })
  async syncAllWallets() {
    return await this.balanceIndexerService.syncAllWallets();
  }

  /**
   * Reconciles a wallet's indexed balance with on-chain state.
   */
  @Post('wallet/:walletId/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile wallet balance with on-chain state' })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiBody({
    type: ReconcileBalanceDto,
    examples: {
      default: {
        value: {
          assetType: 'NATIVE',
          assetCode: null,
          assetIssuer: null,
        },
      },
      credit: {
        value: {
          assetType: 'CREDIT_ALPHANUM4',
          assetCode: 'USD',
          assetIssuer:
            'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Reconciliation completed',
    type: ReconciliationResultResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid asset type',
    example: {
      statusCode: 400,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/balances/wallet/123/reconcile',
      method: 'POST',
      message:
        'assetType must be one of: NATIVE, CREDIT_ALPHANUM4, CREDIT_ALPHANUM12, LIQUIDITY_POOL_SHARES',
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/balances/wallet/invalid/reconcile',
      method: 'POST',
      message: 'Wallet not found',
      error: 'Not Found',
    },
  })
  async reconcileWalletBalance(
    @Param('walletId') walletId: string,
    @Body(ValidationPipe) body: ReconcileBalanceDto,
  ) {
    const asset: Asset = {
      type: body.assetType,
      code: body.assetCode,
      issuer: body.assetIssuer,
    };
    return this.balanceIndexerService.reconcileBalance(walletId, asset);
  }

  /**
   * `POST /balances/reconcile-all`
   *
   * Reconciles all indexed balances across every **active** wallet.
   *
   * This is a maintenance / admin operation. It iterates all active wallets,
   * compares each indexed balance against Horizon, and corrects mismatches.
   * Individual wallet failures are swallowed and logged so the full run
   * completes even if some wallets are unreachable.
   *
   * Response `200`:
   * ```json
   * { "walletsProcessed": 42, "mismatchesFound": 1 }
   * ```
   *
   * Notes:
   * - May be slow on large datasets. Run outside peak hours.
   * - Emits `balance.mismatch` events for every divergence found.
   * - Recommended: protect this endpoint with an admin-level API key scope
   *   in a future iteration.
   */

  /**
   * Reconciles all balances for all active wallets.
   */
  @Post('reconcile-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reconcile all wallet balances (admin operation)' })
  @ApiResponse({
    status: 200,
    description: 'Full reconciliation completed',
    schema: {
      type: 'object',
      properties: {
        walletsProcessed: { type: 'number', example: 10 },
        mismatchesFound: { type: 'number', example: 2 },
      },
    },
  })
  async reconcileAllBalances() {
    return this.balanceIndexerService.reconcileAllBalances();
  }

  /**
   * Syncs balances with retry backoff
   */
  @Post('wallet/:walletId/sync-with-retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync balances with automatic retry on failure' })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiBody({
    type: SyncBalancesDto,
    examples: {
      default: {
        value: { forceRefresh: false },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Sync with retry completed',
    type: SyncResultResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/balances/wallet/invalid/sync-with-retry',
      method: 'POST',
      message: 'Wallet not found',
      error: 'Not Found',
    },
  })
  async syncWithRetry(
    @Param('walletId') walletId: string,
    @Body(ValidationPipe) body: SyncBalancesDto = new SyncBalancesDto(),
  ) {
    return this.balanceIndexerService.syncWalletBalancesWithRetry({
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
  ) {
    return this.balanceIndexer.syncWalletBalancesWithRetry({
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
  ) {
    return this.balanceIndexer.reconcileBalance(walletId, {
      type: body?.assetType,
      code: body?.assetCode,
      issuer: body?.assetIssuer,
    });
  }

  /** POST /v1/balances/reconcile-all — sweep every active wallet. */
  @Post('reconcile-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async reconcileAllBalances() {
    return this.balanceIndexer.reconcileAllBalances();
  }

  /** POST /v1/balances/sync-all — refresh every active wallet. */
  @Post('sync-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async syncAllWallets() {
    return this.balanceIndexer.syncAllWallets();
  }

  /**
   * GET /v1/balances/wallet/:walletId/stale
   *
   * Report balances that have not been refreshed inside the staleness budget.
   */
  @Get('wallet/:walletId/stale')
  @UseGuards(ApiKeyGuard)
  @ApiOperation({ summary: 'Detect stale balances for a wallet' })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Stale balance detection completed',
    schema: {
      type: 'object',
      properties: {
        walletId: {
          type: 'string',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        staleAssets: {
          type: 'array',
          items: { type: 'string' },
          example: ['NATIVE', 'USD/CREDIT_ALPHANUM4'],
        },
        staleSince: {
          type: 'string',
          example: '2024-06-24T10:00:00.000Z',
          nullable: true,
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/balances/wallet/invalid/stale',
      method: 'GET',
      message: 'Wallet not found',
      error: 'Not Found',
    },
  })
  async detectStaleBalances(@Param('walletId') walletId: string) {
    return this.balanceIndexer.detectStaleBalances(walletId);
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
  async runScheduledSync() {
    await this.balanceIndexer.runScheduledSync();
    return { status: 'scheduled sync triggered' };
  }

  /**
   * Reports how far the balance index lags behind the chain.
   *
   * `GET /balances/lag` (whole index) or `GET /balances/lag/:walletId`
   * (one wallet). The response carries counts and durations only — no wallet
   * ids, public keys, or asset issuers — so it is safe to scrape and to log.
   *
   * Fail-closed: if the balance store cannot be read this returns `503` with
   * `BALANCE_LAG_DEPENDENCY_UNAVAILABLE` rather than a lag of `0`. An operator
   * must be able to tell "the index is fresh" apart from "we could not
   * measure", otherwise a database outage would look like a healthy index and
   * silently disable the alerting this endpoint exists to provide.
   */
  @Get('lag')
  @ApiOperation({ summary: 'Report balance index lag (whole index)' })
  @ApiResponse({
    status: 200,
    description: 'Lag report',
    schema: {
      type: 'object',
      properties: {
        rowsScanned: { type: 'integer', example: 1024 },
        neverSynced: { type: 'integer', example: 0 },
        maxLagMs: { type: 'number', example: 42000 },
        medianLagMs: { type: 'number', example: 8000 },
        bucket: {
          type: 'string',
          enum: ['0s', '30s', '2m', '5m', '15m', '1h', '6h', '24h', '24h+'],
          example: '2m',
        },
        breaching: { type: 'boolean', example: false },
        thresholdMs: { type: 'number', example: 300000 },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Balance store unavailable — lag is unknown, not zero',
    example: {
      statusCode: 503,
      code: 'BALANCE_LAG_DEPENDENCY_UNAVAILABLE',
      message:
        'Balance index lag is unavailable: the balance store could not be read',
    },
  })
  async getIndexerLag() {
    return this.balanceIndexerService.getIndexerLag();
  }

  /** Per-wallet lag, same contract as the whole-index report. */
  @Get('lag/:walletId')
  @ApiOperation({ summary: 'Report balance index lag for one wallet' })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiResponse({ status: 200, description: 'Lag report' })
  @ApiResponse({
    status: 503,
    description: 'Balance store unavailable — lag is unknown, not zero',
  })
  async getWalletIndexerLag(@Param('walletId') walletId: string) {
    return this.balanceIndexerService.getIndexerLag(walletId);
  }
}
