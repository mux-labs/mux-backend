import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { ConfigService } from '@nestjs/config';
import { WalletNetwork } from '../wallets/domain/wallet.model';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { BalanceRepository } from './balance.repository';
import { BalanceCacheService } from './balance-cache.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { BalanceIndexerMetricsService } from './balance-indexer-metrics.service';
import { randomUUID } from 'crypto';
import {
  WalletBalance,
  Asset,
  AssetType,
  BalanceSyncStatus,
  BalanceUpdate,
  BalanceChangeEvent,
  ReconciliationResult,
} from './domain/balance.model';

export interface SyncBalancesRequest {
  walletId: string;
  forceRefresh?: boolean;
}

export interface SyncBalancesResult {
  walletId: string;
  balancesUpdated: number;
  mismatchesFound: number;
  syncStatus: BalanceSyncStatus;
  lastSyncedAt: Date;
}

export interface StaleBalanceResult {
  walletId: string;
  staleAssets: string[];
  staleSince?: Date | null;
}

/**
 * Balance Indexer Service
 *
 * Responsibilities:
 * - Index wallet balances from Stellar Horizon
 * - Provide fast balance queries without hitting the blockchain
 * - Detect and reconcile balance mismatches
 * - Handle missed updates and recovery
 *
 * Domain events emitted:
 * - `balance.updated`  — when a balance value changes during a sync
 * - `balance.mismatch` — when indexed balance diverges from on-chain state
 *
 * Environment variables (validated at startup):
 * - `STELLAR_HORIZON_URL`        — Horizon API base URL (required)
 * - `BALANCE_STALE_THRESHOLD_MS` — Staleness window in ms (default: 300 000)
 */
@Injectable()
export class BalanceIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BalanceIndexerService.name);
  private readonly staleThresholdMs: number;
  private readonly syncIntervalMs: number;
  private readonly maxRetries: number;
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly processedBalanceEvents = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarHorizonService: StellarHorizonService,
    private readonly configService: ConfigService,
    private readonly webhookEventEmitter: WebhookEventEmitterService,
    private readonly requestContext: RequestContextService,
    private readonly metrics: BalanceIndexerMetricsService,
    private readonly balanceRepo: BalanceRepository,
    @Optional() private readonly balanceCache?: BalanceCacheService,
  ) {
    this.staleThresholdMs = this.configService.get<number>(
      'BALANCE_STALE_THRESHOLD_MS',
      5 * 60 * 1000,
    );
    this.syncIntervalMs = this.configService.get<number>(
      'BALANCE_SYNC_INTERVAL_MS',
      10 * 60 * 1000, // 10 minutes
    );
    this.maxRetries = this.configService.get<number>(
      'BALANCE_SYNC_MAX_RETRIES',
      3,
    );
  }

  /**
   * Validates required environment variables and starts the scheduled sync
   * timer. Throws if `STELLAR_HORIZON_URL` is missing/empty so the
   * application fails fast instead of silently falling back to an
   * unexpected default.
   */
  onModuleInit(): void {
    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL');
    if (!horizonUrl || horizonUrl.trim() === '') {
      throw new Error(
        'STELLAR_HORIZON_URL must be set. ' +
          'Example: https://horizon-testnet.stellar.org',
      );
    }

    const threshold = this.configService.get<number>(
      'BALANCE_STALE_THRESHOLD_MS',
    );
    if (threshold !== undefined && (isNaN(threshold) || threshold <= 0)) {
      throw new Error(
        'BALANCE_STALE_THRESHOLD_MS must be a positive number when set.',
      );
    }

    this.logger.log(
      `Balance indexer ready (horizon=${horizonUrl}, staleThresholdMs=${this.staleThresholdMs})`,
    );

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    this.syncTimer = setInterval(
      () => this.runScheduledSync(),
      this.syncIntervalMs,
    );
    this.logger.log(
      `Scheduled balance sync started (interval: ${this.syncIntervalMs}ms)`,
    );
  }

  onModuleDestroy() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Scheduled worker: syncs all active wallets
   */
  async runScheduledSync(): Promise<void> {
    const cronRequestId = `cron-${randomUUID()}`;
    await RequestContextService.run({ requestId: cronRequestId }, async () => {
      this.logger.log(
        `[${cronRequestId}] Running scheduled balance sync for all active wallets`,
      );
      const startTime = Date.now();
      try {
        const wallets = await this.balanceRepo.findActiveWallets();
        for (const wallet of wallets) {
          await this.syncWalletBalancesWithRetry({ walletId: wallet.id }).catch(
            (err) =>
              this.logger.error(
                `[${cronRequestId}] Scheduled sync failed for wallet ${wallet.id}:`,
                err,
              ),
          );
        }
        this.metrics.record({
          operation: 'sync_all',
          outcome: 'success',
          durationMs: Date.now() - startTime,
          walletsProcessed: wallets.length,
        });
      } catch (err) {
        this.logger.error(
          `[${cronRequestId}] Scheduled balance sync encountered an error:`,
          err,
        );
        this.metrics.record({
          operation: 'sync_all',
          outcome: 'failure',
          durationMs: Date.now() - startTime,
        });
      }
    });
  }

  /**
   * Syncs with exponential backoff retry
   */
  async syncWalletBalancesWithRetry(
    request: SyncBalancesRequest,
    attempt = 0,
  ): Promise<SyncBalancesResult> {
    const requestId = this.requestContext.getRequestId() || 'N/A';
    try {
      return await this.syncWalletBalances(request);
    } catch (error) {
      const isClientError =
        error instanceof NotFoundException ||
        error?.status === 400 ||
        error?.status === 404 ||
        error?.message?.includes('not found');
      if (isClientError || attempt >= this.maxRetries) {
        throw error;
      }
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      this.logger.warn(
        `[${requestId}] Sync retry ${attempt + 1}/${this.maxRetries} for wallet ${request.walletId} in ${delay}ms. Error: ${error.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.syncWalletBalancesWithRetry(request, attempt + 1);
    }
  }

  /**
   * Detects stale balances for a wallet and marks them in the DB
   */
  async detectStaleBalances(walletId: string): Promise<StaleBalanceResult> {
    const requestId = this.requestContext.getRequestId() || 'N/A';
    const startTime = Date.now();
    try {
      const balances = await this.prisma.walletBalance.findMany({
        where: { walletId },
      });
      const staleAssets: string[] = [];
      let oldestStale: Date | null = null;

      for (const b of balances) {
        if (this.isBalanceStale(b)) {
          const label = b.assetCode
            ? `${b.assetCode}/${b.assetType}`
            : b.assetType;
          staleAssets.push(label);
          if (
            !oldestStale ||
            (b.lastSyncedAt && b.lastSyncedAt < oldestStale)
          ) {
            oldestStale = b.lastSyncedAt ?? null;
          }
          await this.prisma.walletBalance.update({
            where: { id: b.id },
            data: { syncStatus: BalanceSyncStatus.STALE },
          });
        }
      }

      if (staleAssets.length > 0) {
        this.logger.warn(
          `[${requestId}] Stale balances detected for wallet ${walletId}: ${staleAssets.join(', ')}`,
        );
      }

      this.metrics.record({
        operation: 'detect_stale',
        outcome: 'success',
        durationMs: Date.now() - startTime,
      });

      return { walletId, staleAssets, staleSince: oldestStale };
    } catch (error) {
      this.metrics.record({
        operation: 'detect_stale',
        outcome: 'failure',
        durationMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Returns the cached balance for a wallet + asset combination.
   *
   * If the record exists but is stale, a background sync is triggered
   * asynchronously so the caller always gets a fast response.
   *
   * @param walletId  UUID of the wallet
   * @param asset     Asset descriptor (type, optional code/issuer)
   * @returns Cached `WalletBalance` or `null` if not indexed yet
   */
  async getBalance(
    walletId: string,
    asset: Asset,
  ): Promise<WalletBalance | null> {
    const requestId = this.requestContext.getRequestId() || 'N/A';

    // Cache-aside: serve from in-memory cache when fresh
    const cached = this.balanceCache?.get(walletId, asset);
    if (cached) {
      this.logger.debug(
        `[${requestId}] Cache hit for wallet ${walletId} asset ${asset.type}`,
      );
      return cached;
    }

    const balance = await this.balanceRepo.findOne(walletId, asset);

    if (!balance) return null;

    if (this.isBalanceStale(balance)) {
      this.logger.warn(
        `[${requestId}] Balance is stale for wallet ${walletId}, asset ${asset.type}`,
      );
      // Trigger async refresh — do not await so the caller isn't blocked
      this.syncWalletBalancesWithRetry({ walletId }).catch((err) =>
        this.logger.error(
          `[${requestId}] Background balance refresh failed:`,
          err,
        ),
      );
    } else {
      this.balanceCache?.set(walletId, asset, balance);
    }

    return balance;
  }

  /**
   * Returns all cached balances for a wallet, ordered by asset type.
   *
   * @param walletId UUID of the wallet
   */
  async getAllBalances(walletId: string): Promise<WalletBalance[]> {
    return this.balanceRepo.findAll(walletId);
  }

  /**
   * Indexes a Stellar balance-change event into the database.
   * Handles idempotency (same ledger + tx hash) and out-of-order events.
   */
  async indexBalanceEvent(event: BalanceChangeEvent): Promise<void> {
    const eventKey = this.balanceEventKey(event);
    if (this.processedBalanceEvents.has(eventKey)) {
      this.logger.debug(`Skipping duplicate balance event ${eventKey}`);
      return;
    }

    const existing = await this.balanceRepo.findOne(
      event.walletId,
      event.asset,
    );

    if (
      existing?.lastSyncedLedger != null &&
      event.ledgerSequence < existing.lastSyncedLedger
    ) {
      this.logger.warn(
        `Ignoring out-of-order balance event for wallet ${event.walletId} ` +
          `(event ledger ${event.ledgerSequence} < indexed ${existing.lastSyncedLedger})`,
      );
      return;
    }

    await this.applyBalanceUpdate(
      event.walletId,
      {
        walletId: event.walletId,
        asset: event.asset,
        balance: event.balance,
        ledgerSequence: event.ledgerSequence,
        timestamp: event.timestamp ?? new Date(),
        transactionHash: event.transactionHash,
      },
      true,
    );

    this.processedBalanceEvents.add(eventKey);
  }

  /**
   * Syncs balances from Stellar Horizon for a single wallet.
   * Creates a BalanceSyncJob record for observability.
   */
  async syncWalletBalances(
    request: SyncBalancesRequest,
  ): Promise<SyncBalancesResult> {
    const startTime = Date.now();
    const { walletId, forceRefresh = false } = request;
    const requestId = this.requestContext.getRequestId();
    const logPrefix = requestId ? `[${requestId}] ` : '';

    this.logger.log(`${logPrefix}Starting balance sync for wallet ${walletId}`);

    const job = await this.prisma.balanceSyncJob.create({
      data: {
        jobType: 'INCREMENTAL_SYNC',
        status: 'RUNNING',
        walletId,
        requestId,
        startedAt: new Date(),
      },
    });

    try {
      const wallet = await this.balanceRepo.findWallet(walletId);

      if (!wallet) {
        throw new NotFoundException(`Wallet ${walletId} not found`);
      }

      // Check if account exists on-chain (on the wallet's own network)
      const accountExists = await this.stellarHorizonService.accountExists(
        wallet.publicKey,
        wallet.network as WalletNetwork,
      );

      if (!accountExists) {
        this.logger.warn(
          `${logPrefix}Account ${wallet.publicKey} not found on-chain, setting zero balances`,
        );
        const result = await this.setZeroBalances(walletId);

        await this.prisma.balanceSyncJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            duration: Date.now() - startTime,
            balancesUpdated: result.balancesUpdated,
          },
        });

        this.metrics.record({
          operation: 'sync',
          outcome: 'success',
          durationMs: Date.now() - startTime,
          balancesUpdated: result.balancesUpdated,
          mismatchesFound: 0,
        });

        return result;
      }

      // Fetch balances from Horizon
      const horizonBalances = await this.stellarHorizonService.getAccountBalances(
        wallet.publicKey,
        wallet.network as WalletNetwork,
      );

      let balancesUpdated = 0;
      let mismatchesFound = 0;

      for (const balanceUpdate of horizonBalances) {
        const result = await this.applyBalanceUpdate(
          walletId,
          balanceUpdate,
          forceRefresh,
        );
        if (result.updated) balancesUpdated++;
        if (result.mismatch) mismatchesFound++;
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `${logPrefix}Balance sync completed for wallet ${walletId} in ${duration}ms ` +
          `(${balancesUpdated} updated, ${mismatchesFound} mismatches)`,
      );

      await this.prisma.balanceSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          duration,
          balancesUpdated,
          mismatchesFound,
        },
      });

      this.metrics.record({
        operation: 'sync',
        outcome: 'success',
        durationMs: duration,
        balancesUpdated,
        mismatchesFound,
      });

      // Invalidate cache for this wallet after a successful sync
      this.balanceCache?.invalidateAll(walletId);

      return {
        walletId,
        balancesUpdated,
        mismatchesFound,
        syncStatus:
          mismatchesFound > 0
            ? BalanceSyncStatus.MISMATCH
            : BalanceSyncStatus.SYNCED,
        lastSyncedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(
        `${logPrefix}Balance sync failed for wallet ${walletId}:`,
        error,
      );

      await this.balanceRepo.markFailed(walletId);

      await this.prisma.balanceSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          duration: Date.now() - startTime,
          errorMessage: error.message,
        },
      });

      this.metrics.record({
        operation: 'sync',
        outcome: 'failure',
        durationMs: Date.now() - startTime,
      });

      throw new Error(`Balance sync failed: ${error.message}`);
    }
  }

  /**
   * Reconciles a specific asset balance against the live on-chain state.
   *
   * Emits `balance.mismatch` when a divergence is detected and automatically
   * corrects the indexed value.
   *
   * @param walletId UUID of the wallet
   * @param asset    Asset to reconcile
   * @returns        Reconciliation outcome with indexed vs on-chain values
   */
  async reconcileBalance(
    walletId: string,
    asset: Asset,
  ): Promise<ReconciliationResult> {
    const startTime = Date.now();
    const requestId = this.requestContext.getRequestId() || 'N/A';
    const logPrefix = requestId ? `[${requestId}] ` : '';

    this.logger.log(
      `${logPrefix}Reconciling balance for wallet ${walletId}, asset ${asset.type}`,
    );

    const indexedBalance = await this.getBalance(walletId, asset);

    const wallet = await this.balanceRepo.findWallet(walletId);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const horizonBalances = await this.stellarHorizonService.getAccountBalances(
      wallet.publicKey,
      wallet.network as WalletNetwork,
    );
    const onChainBalance = horizonBalances.find((b) =>
      this.assetsMatch(b.asset, asset),
    );

    const indexed = indexedBalance?.balance ?? '0';
    const onChain = onChainBalance?.balance ?? '0';
    const matches = indexed === onChain;

    if (!matches) {
      this.logger.warn(
        `${logPrefix}Balance mismatch detected for wallet ${walletId}: ` +
          `indexed=${indexed}, onChain=${onChain}`,
      );

      if (onChainBalance) {
        await this.applyBalanceUpdate(walletId, onChainBalance, true);
      }

      await this.balanceRepo.recordMismatch(walletId, asset);

      // Emit balance.mismatch webhook (fire-and-forget)
      const assetLabel = asset.code ?? asset.type;
      const difference = this.calculateDifference(indexed, onChain);
      this.webhookEventEmitter
        .emitBalanceMismatch({
          walletId,
          asset: assetLabel,
          indexedBalance: indexed,
          onChainBalance: onChain,
          difference,
        })
        .catch((err) =>
          this.logger.error(
            `${logPrefix}Failed to emit balance.mismatch webhook:`,
            err,
          ),
        );
    } else {
      await this.balanceRepo.clearMismatch(walletId, asset);
    }

    this.metrics.record({
      operation: 'reconcile',
      outcome: 'success',
      durationMs: Date.now() - startTime,
      mismatchesFound: matches ? 0 : 1,
    });

    return {
      walletId,
      asset,
      indexedBalance: indexed,
      onChainBalance: onChain,
      matches,
      difference: matches
        ? undefined
        : this.calculateDifference(indexed, onChain),
    };
  }

  /**
   * Reconciles all balances across every active wallet.
   *
   * Intended as a scheduled maintenance operation. Errors for individual
   * wallets are caught and logged rather than aborting the full run.
   * Tracked via a BalanceSyncJob record.
   *
   * @returns Summary of wallets processed and mismatches found
   */
  async reconcileAllBalances(): Promise<{
    walletsProcessed: number;
    mismatchesFound: number;
  }> {
    const requestId =
      this.requestContext.getRequestId() || `rec-${randomUUID()}`;
    return await RequestContextService.run({ requestId }, async () => {
      const startTime = Date.now();
      const logPrefix = `[${requestId}] `;
      this.logger.log(`${logPrefix}Starting full balance reconciliation`);

      const job = await this.prisma.balanceSyncJob.create({
        data: {
          jobType: 'RECONCILIATION',
          status: 'RUNNING',
          requestId,
          startedAt: new Date(),
        },
      });

      const wallets = await this.balanceRepo.findActiveWallets();

      let walletsProcessed = 0;
      let mismatchesFound = 0;
      let errorsEncountered = 0;

      try {
        for (const wallet of wallets) {
          try {
            const balances = await this.getAllBalances(wallet.id);

            for (const balance of balances) {
              const asset: Asset = {
                type: balance.assetType,
                code: balance.assetCode ?? undefined,
                issuer: balance.assetIssuer ?? undefined,
              };

              const result = await this.reconcileBalance(wallet.id, asset);
              if (!result.matches) mismatchesFound++;
            }

            walletsProcessed++;
          } catch (error) {
            this.logger.error(
              `${logPrefix}Failed to reconcile wallet ${wallet.id}:`,
              error,
            );
            errorsEncountered++;
          }
        }

        await this.prisma.balanceSyncJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            walletsProcessed,
            walletsTotal: wallets.length,
            mismatchesFound,
            errorsEncountered,
          },
        });

        this.logger.log(
          `${logPrefix}Full reconciliation completed: ${walletsProcessed} wallets, ${mismatchesFound} mismatches`,
        );

        this.metrics.record({
          operation: 'reconcile_all',
          outcome: 'success',
          durationMs: Date.now() - startTime,
          walletsProcessed,
          mismatchesFound,
          errorsEncountered,
        });

        return { walletsProcessed, mismatchesFound };
      } catch (error) {
        this.logger.error(
          `${logPrefix}Full balance reconciliation failed:`,
          error,
        );
        await this.prisma.balanceSyncJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            duration: Date.now() - startTime,
            errorMessage: error.message,
          },
        });

        this.metrics.record({
          operation: 'reconcile_all',
          outcome: 'failure',
          durationMs: Date.now() - startTime,
        });

        throw error;
      }
    });
  }

  /**
   * Triggers a full sync across all active wallets.
   * Used by the manual sync-all admin endpoint.
   */
  async syncAllWallets(): Promise<{
    walletsProcessed: number;
    balancesUpdated: number;
    mismatchesFound: number;
  }> {
    const requestId =
      this.requestContext.getRequestId() || `syncall-${randomUUID()}`;
    return await RequestContextService.run({ requestId }, async () => {
      const startTime = Date.now();
      const logPrefix = `[${requestId}] `;
      this.logger.log(`${logPrefix}Starting full wallet balance sync`);

      const job = await this.prisma.balanceSyncJob.create({
        data: {
          jobType: 'FULL_SYNC',
          status: 'RUNNING',
          requestId,
          startedAt: new Date(),
        },
      });

      const wallets = await this.balanceRepo.findActiveWallets();

      let walletsProcessed = 0;
      let balancesUpdated = 0;
      let mismatchesFound = 0;
      let errorsEncountered = 0;

      try {
        for (const wallet of wallets) {
          try {
            const result = await this.syncWalletBalancesWithRetry({
              walletId: wallet.id,
            });
            walletsProcessed++;
            balancesUpdated += result.balancesUpdated;
            mismatchesFound += result.mismatchesFound;
          } catch (error) {
            this.logger.error(
              `${logPrefix}Failed to sync wallet ${wallet.id}:`,
              error,
            );
            errorsEncountered++;
          }
        }

        await this.prisma.balanceSyncJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            duration: Date.now() - startTime,
            walletsProcessed,
            walletsTotal: wallets.length,
            balancesUpdated,
            mismatchesFound,
            errorsEncountered,
          },
        });

        this.metrics.record({
          operation: 'sync_all',
          outcome: 'success',
          durationMs: Date.now() - startTime,
          walletsProcessed,
          balancesUpdated,
          mismatchesFound,
          errorsEncountered,
        });

        return { walletsProcessed, balancesUpdated, mismatchesFound };
      } catch (error) {
        this.logger.error(`${logPrefix}Full wallet sync failed:`, error);
        await this.prisma.balanceSyncJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            duration: Date.now() - startTime,
            errorMessage: error.message,
          },
        });

        this.metrics.record({
          operation: 'sync_all',
          outcome: 'failure',
          durationMs: Date.now() - startTime,
        });

        throw error;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Upserts a single balance record and emits `balance.updated` when the
   * stored value changes.
   */
  private async applyBalanceUpdate(
    walletId: string,
    balanceUpdate: BalanceUpdate,
    forceUpdate: boolean,
  ): Promise<{ updated: boolean; mismatch: boolean }> {
    const existing = await this.balanceRepo.findOne(
      walletId,
      balanceUpdate.asset,
    );

    if (
      !forceUpdate &&
      existing?.lastSyncedLedger != null &&
      balanceUpdate.ledgerSequence < existing.lastSyncedLedger
    ) {
      return { updated: false, mismatch: false };
    }

    const previousBalance = existing?.balance ?? null;
    const mismatch =
      existing != null && existing.balance !== balanceUpdate.balance;

    await this.balanceRepo.upsert(walletId, balanceUpdate);

    // Emit balance.updated when the value actually changed
    if (previousBalance !== null && previousBalance !== balanceUpdate.balance) {
      const assetLabel = balanceUpdate.asset.code ?? balanceUpdate.asset.type;
      const change = this.calculateDifference(
        balanceUpdate.balance,
        previousBalance,
      );
      this.webhookEventEmitter
        .emitBalanceUpdated({
          walletId,
          asset: assetLabel,
          previousBalance,
          newBalance: balanceUpdate.balance,
          change,
        })
        .catch((err) =>
          this.logger.error('Failed to emit balance.updated event:', err),
        );
    }

    return { updated: true, mismatch };
  }

  private async setZeroBalances(walletId: string): Promise<SyncBalancesResult> {
    await this.balanceRepo.upsertNativeZero(walletId);

    return {
      walletId,
      balancesUpdated: 1,
      mismatchesFound: 0,
      syncStatus: BalanceSyncStatus.SYNCED,
      lastSyncedAt: new Date(),
    };
  }

  private isBalanceStale(balance: WalletBalance): boolean {
    if (!balance.lastSyncedAt) return true;
    return Date.now() - balance.lastSyncedAt.getTime() > this.staleThresholdMs;
  }

  private assetsMatch(a: Asset, b: Asset): boolean {
    return a.type === b.type && a.code === b.code && a.issuer === b.issuer;
  }

  private calculateDifference(a: string, b: string): string {
    return (parseFloat(a) - parseFloat(b)).toFixed(7);
  }

  private assetCompoundKey(walletId: string, asset: Asset) {
    return {
      walletId,
      assetType: asset.type,
      assetCode: asset.code ?? null,
      assetIssuer: asset.issuer ?? null,
    } as any;
  }

  private balanceEventKey(event: BalanceChangeEvent): string {
    const assetKey = [
      event.asset.type,
      event.asset.code ?? '',
      event.asset.issuer ?? '',
    ].join(':');
    return `${event.walletId}:${assetKey}:${event.ledgerSequence}:${event.transactionHash}`;
  }
}
