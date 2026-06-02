import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StellarHorizonService } from './stellar-horizon.service';
import { ConfigService } from '@nestjs/config';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import {
  WalletBalance,
  Asset,
  AssetType,
  BalanceSyncStatus,
  BalanceUpdate,
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
 * Architecture:
 * ┌─────────────────────────────────────────────────────────┐
 * │                  BalanceIndexerService                  │
 * │                                                         │
 * │  getBalance()          → cached read from DB            │
 * │  getAllBalances()       → cached reads from DB           │
 * │  syncWalletBalances()  → fetch Horizon → upsert DB      │
 * │  reconcileBalance()    → compare DB vs Horizon          │
 * │  reconcileAllBalances()→ full sweep across active wallets│
 * └──────────┬──────────────────────┬───────────────────────┘
 *            │                      │
 *   ┌────────▼────────┐   ┌────────▼──────────────┐
 *   │  PrismaService  │   │  StellarHorizonService │
 *   │  (PostgreSQL)   │   │  (Horizon REST API)    │
 *   └─────────────────┘   └────────────────────────┘
 *
 * Stale detection:
 *   - Balances older than BALANCE_STALE_THRESHOLD_MS (default 5 min) trigger
 *     an async background refresh on next read. The stale value is still
 *     returned immediately so the caller is never blocked.
 *
 * Mismatch handling:
 *   - On reconciliation, if indexed != on-chain the indexed value is corrected
 *     and `mismatchDetectedAt` / `reconciliationAttempts` are incremented for
 *     observability.
 *
 * Manual sync:
 *   - POST /balances/wallet/:walletId/sync  (per-wallet)
 *   - POST /balances/sync-all              (full sweep, admin)
 */
@Injectable()
export class BalanceIndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BalanceIndexerService.name);
  private readonly staleThresholdMs: number;
  private readonly syncIntervalMs: number;
  private readonly maxRetries: number;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarHorizonService: StellarHorizonService,
    private readonly configService: ConfigService,
    private readonly webhookEventEmitter: WebhookEventEmitterService,
  ) {
    this.staleThresholdMs = this.configService.get<number>(
      'BALANCE_STALE_THRESHOLD_MS',
      5 * 60 * 1000,
    );
    this.syncIntervalMs = this.configService.get<number>(
      'BALANCE_SYNC_INTERVAL_MS',
      10 * 60 * 1000, // 10 minutes
    );
    this.maxRetries = this.configService.get<number>('BALANCE_SYNC_MAX_RETRIES', 3);
  }

  onModuleInit() {
    this.syncTimer = setInterval(() => this.runScheduledSync(), this.syncIntervalMs);
    this.logger.log(`Scheduled balance sync started (interval: ${this.syncIntervalMs}ms)`);
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
    this.logger.log('Running scheduled balance sync for all active wallets');
    try {
      const wallets = await this.prisma.wallet.findMany({ where: { status: 'ACTIVE' } });
      for (const wallet of wallets) {
        await this.syncWalletBalancesWithRetry({ walletId: wallet.id }).catch((err) =>
          this.logger.error(`Scheduled sync failed for wallet ${wallet.id}:`, err),
        );
      }
    } catch (err) {
      this.logger.error('Scheduled balance sync encountered an error:', err);
    }
  }

  /**
   * Syncs with exponential backoff retry
   */
  async syncWalletBalancesWithRetry(
    request: SyncBalancesRequest,
    attempt = 0,
  ): Promise<SyncBalancesResult> {
    try {
      return await this.syncWalletBalances(request);
    } catch (error) {
      if (attempt >= this.maxRetries) {
        throw error;
      }
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      this.logger.warn(
        `Sync retry ${attempt + 1}/${this.maxRetries} for wallet ${request.walletId} in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.syncWalletBalancesWithRetry(request, attempt + 1);
    }
  }

  /**
   * Detects stale balances for a wallet and marks them in the DB
   */
  async detectStaleBalances(walletId: string): Promise<StaleBalanceResult> {
    const balances = await this.prisma.walletBalance.findMany({ where: { walletId } });
    const staleAssets: string[] = [];
    let oldestStale: Date | null = null;

    for (const b of balances) {
      if (this.isBalanceStale(b)) {
        const label = b.assetCode ? `${b.assetCode}/${b.assetType}` : b.assetType;
        staleAssets.push(label);
        if (!oldestStale || (b.lastSyncedAt && b.lastSyncedAt < oldestStale)) {
          oldestStale = b.lastSyncedAt ?? null;
        }
        await this.prisma.walletBalance.update({
          where: { id: b.id },
          data: { syncStatus: BalanceSyncStatus.STALE },
        });
      }
    }

    if (staleAssets.length > 0) {
      this.logger.warn(`Stale balances detected for wallet ${walletId}: ${staleAssets.join(', ')}`);
    }

    return { walletId, staleAssets, staleSince: oldestStale };
  }

  /**
   * Gets cached balance for a wallet and asset.
   * Triggers a background refresh if the balance is stale.
   */
  async getBalance(
    walletId: string,
    asset: Asset,
  ): Promise<WalletBalance | null> {
    const balance = await this.prisma.walletBalance.findUnique({
      where: {
        walletId_assetType_assetCode_assetIssuer: {
          walletId,
          assetType: asset.type,
          assetCode: asset.code || null,
          assetIssuer: asset.issuer || null,
        },
      },
    });

    if (!balance) return null;

    if (this.isBalanceStale(balance)) {
      this.logger.warn(
        `Balance is stale for wallet ${walletId}, asset ${asset.type}`,
      );
      this.syncWalletBalances({ walletId }).catch((err) =>
        this.logger.error(`Background balance refresh failed:`, err),
      );
    }

    return this.mapPrismaBalanceToDomain(balance);
  }

  /**
   * Gets all cached balances for a wallet.
   */
  async getAllBalances(walletId: string): Promise<WalletBalance[]> {
    const balances = await this.prisma.walletBalance.findMany({
      where: { walletId },
      orderBy: { assetType: 'asc' },
    });
    return balances.map((b) => this.mapPrismaBalanceToDomain(b));
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

    this.logger.log(`Starting balance sync for wallet ${walletId}`);

    const job = await this.prisma.balanceSyncJob.create({
      data: {
        jobType: 'INCREMENTAL_SYNC',
        status: 'RUNNING',
        walletId,
        startedAt: new Date(),
      },
    });

    try {
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: walletId },
      });

      if (!wallet) {
        throw new NotFoundException(`Wallet ${walletId} not found`);
      }

      const accountExists = await this.stellarHorizonService.accountExists(
        wallet.publicKey,
      );

      if (!accountExists) {
        this.logger.warn(
          `Account ${wallet.publicKey} not found on-chain, setting zero balances`,
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
        return result;
      }

      const horizonBalances =
        await this.stellarHorizonService.getAccountBalances(wallet.publicKey);

      let balancesUpdated = 0;
      let mismatchesFound = 0;

      for (const balanceUpdate of horizonBalances) {
        const result = await this.updateBalance(
          walletId,
          balanceUpdate,
          forceRefresh,
        );
        if (result.updated) balancesUpdated++;
        if (result.mismatch) mismatchesFound++;
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Balance sync completed for wallet ${walletId} in ${duration}ms ` +
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
      this.logger.error(`Balance sync failed for wallet ${walletId}:`, error);

      await this.prisma.walletBalance.updateMany({
        where: { walletId },
        data: { syncStatus: BalanceSyncStatus.FAILED },
      });

      await this.prisma.balanceSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          duration: Date.now() - startTime,
          errorMessage: error.message,
        },
      });

      throw new Error(`Balance sync failed: ${error.message}`);
    }
  }

  /**
   * Reconciles indexed balance with on-chain state for a specific asset.
   */
  async reconcileBalance(
    walletId: string,
    asset: Asset,
  ): Promise<ReconciliationResult> {
    this.logger.log(
      `Reconciling balance for wallet ${walletId}, asset ${asset.type}`,
    );

    const indexedBalance = await this.getBalance(walletId, asset);

    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    const horizonBalances = await this.stellarHorizonService.getAccountBalances(
      wallet.publicKey,
    );

    const onChainBalance = horizonBalances.find((b) =>
      this.assetsMatch(b.asset, asset),
    );

    const indexed = indexedBalance?.balance || '0';
    const onChain = onChainBalance?.balance || '0';
    const matches = indexed === onChain;

    if (!matches) {
      this.logger.warn(
        `Balance mismatch detected for wallet ${walletId}: ` +
          `indexed=${indexed}, onChain=${onChain}`,
      );

      if (onChainBalance) {
        await this.updateBalance(walletId, onChainBalance, true);
      }

      await this.prisma.walletBalance.updateMany({
        where: {
          walletId,
          assetType: asset.type,
          assetCode: asset.code || null,
          assetIssuer: asset.issuer || null,
        },
        data: {
          mismatchDetectedAt: new Date(),
          reconciliationAttempts: { increment: 1 },
        },
      });

      // Emit balance.mismatch webhook (fire-and-forget)
      const assetLabel = asset.code || asset.type;
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
          this.logger.error('Failed to emit balance.mismatch webhook:', err),
        );
    } else {
      await this.prisma.walletBalance.updateMany({
        where: {
          walletId,
          assetType: asset.type,
          assetCode: asset.code || null,
          assetIssuer: asset.issuer || null,
        },
        data: {
          mismatchDetectedAt: null,
          lastReconciledAt: new Date(),
        },
      });
    }

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
   * Reconciles all balances for all active wallets (maintenance operation).
   * Tracked via a BalanceSyncJob record.
   */
  async reconcileAllBalances(): Promise<{
    walletsProcessed: number;
    mismatchesFound: number;
  }> {
    this.logger.log('Starting full balance reconciliation');

    const job = await this.prisma.balanceSyncJob.create({
      data: {
        jobType: 'RECONCILIATION',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    const wallets = await this.prisma.wallet.findMany({
      where: { status: 'ACTIVE' },
    });

    let walletsProcessed = 0;
    let mismatchesFound = 0;
    let errorsEncountered = 0;

    for (const wallet of wallets) {
      try {
        const balances = await this.getAllBalances(wallet.id);

        for (const balance of balances) {
          const asset: Asset = {
            type: balance.assetType,
            code: balance.assetCode || undefined,
            issuer: balance.assetIssuer || undefined,
          };

          const result = await this.reconcileBalance(wallet.id, asset);
          if (!result.matches) mismatchesFound++;
        }

        walletsProcessed++;
      } catch (error) {
        this.logger.error(`Failed to reconcile wallet ${wallet.id}:`, error);
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
      `Full reconciliation completed: ${walletsProcessed} wallets, ${mismatchesFound} mismatches`,
    );

    return { walletsProcessed, mismatchesFound };
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
    this.logger.log('Starting full wallet balance sync');

    const job = await this.prisma.balanceSyncJob.create({
      data: {
        jobType: 'FULL_SYNC',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    const wallets = await this.prisma.wallet.findMany({
      where: { status: 'ACTIVE' },
    });

    let walletsProcessed = 0;
    let balancesUpdated = 0;
    let mismatchesFound = 0;
    let errorsEncountered = 0;
    const startTime = Date.now();

    for (const wallet of wallets) {
      try {
        const result = await this.syncWalletBalances({ walletId: wallet.id });
        walletsProcessed++;
        balancesUpdated += result.balancesUpdated;
        mismatchesFound += result.mismatchesFound;
      } catch (error) {
        this.logger.error(`Failed to sync wallet ${wallet.id}:`, error);
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

    return { walletsProcessed, balancesUpdated, mismatchesFound };
  }

  private async updateBalance(
    walletId: string,
    balanceUpdate: BalanceUpdate,
    forceUpdate: boolean = false,
  ): Promise<{ updated: boolean; mismatch: boolean }> {
    const { asset, balance, ledgerSequence, timestamp } = balanceUpdate;

    const existing = await this.prisma.walletBalance.findUnique({
      where: {
        walletId_assetType_assetCode_assetIssuer: {
          walletId,
          assetType: asset.type,
          assetCode: asset.code || null,
          assetIssuer: asset.issuer || null,
        },
      },
    });

    const mismatch = existing !== null && existing.balance !== balance;

    await this.prisma.walletBalance.upsert({
      where: {
        walletId_assetType_assetCode_assetIssuer: {
          walletId,
          assetType: asset.type,
          assetCode: asset.code || null,
          assetIssuer: asset.issuer || null,
        },
      },
      create: {
        walletId,
        assetType: asset.type,
        assetCode: asset.code || null,
        assetIssuer: asset.issuer || null,
        balance,
        syncStatus: BalanceSyncStatus.SYNCED,
        lastSyncedAt: timestamp,
        lastSyncedLedger: ledgerSequence,
        onChainBalance: balance,
      },
      update: {
        balance,
        syncStatus: BalanceSyncStatus.SYNCED,
        lastSyncedAt: timestamp,
        lastSyncedLedger: ledgerSequence,
        onChainBalance: balance,
        updatedAt: new Date(),
      },
    });

    return { updated: true, mismatch };
  }

  private async setZeroBalances(walletId: string): Promise<SyncBalancesResult> {
    await this.prisma.walletBalance.upsert({
      where: {
        walletId_assetType_assetCode_assetIssuer: {
          walletId,
          assetType: AssetType.NATIVE,
          assetCode: null,
          assetIssuer: null,
        },
      },
      create: {
        walletId,
        assetType: AssetType.NATIVE,
        assetCode: null,
        assetIssuer: null,
        balance: '0',
        syncStatus: BalanceSyncStatus.SYNCED,
        lastSyncedAt: new Date(),
      },
      update: {
        balance: '0',
        syncStatus: BalanceSyncStatus.SYNCED,
        lastSyncedAt: new Date(),
      },
    });

    return {
      walletId,
      balancesUpdated: 1,
      mismatchesFound: 0,
      syncStatus: BalanceSyncStatus.SYNCED,
      lastSyncedAt: new Date(),
    };
  }

  private isBalanceStale(balance: any): boolean {
    if (!balance.lastSyncedAt) return true;
    return Date.now() - balance.lastSyncedAt.getTime() > this.staleThresholdMs;
  }

  private assetsMatch(asset1: Asset, asset2: Asset): boolean {
    return (
      asset1.type === asset2.type &&
      asset1.code === asset2.code &&
      asset1.issuer === asset2.issuer
    );
  }

  private calculateDifference(balance1: string, balance2: string): string {
    return (parseFloat(balance1) - parseFloat(balance2)).toFixed(7);
  }

  private mapPrismaBalanceToDomain(prismaBalance: any): WalletBalance {
    return {
      id: prismaBalance.id,
      walletId: prismaBalance.walletId,
      assetType: prismaBalance.assetType as AssetType,
      assetCode: prismaBalance.assetCode,
      assetIssuer: prismaBalance.assetIssuer,
      balance: prismaBalance.balance,
      syncStatus: prismaBalance.syncStatus as BalanceSyncStatus,
      lastSyncedAt: prismaBalance.lastSyncedAt,
      lastSyncedLedger: prismaBalance.lastSyncedLedger,
      lastReconciledAt: prismaBalance.lastReconciledAt,
      reconciliationAttempts: prismaBalance.reconciliationAttempts,
      onChainBalance: prismaBalance.onChainBalance,
      mismatchDetectedAt: prismaBalance.mismatchDetectedAt,
      createdAt: prismaBalance.createdAt,
      updatedAt: prismaBalance.updatedAt,
    };
  }
}
