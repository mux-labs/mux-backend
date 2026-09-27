import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  BALANCE_STORE,
  BALANCE_SYNC_ENABLED_ENV,
  BalanceIndexerErrorCode,
  DEFAULT_BALANCE_STALE_THRESHOLD_MS,
  HORIZON_BALANCE_CLIENT,
  MAX_SWEEP_WALLETS,
} from './balance-indexer.error-codes';
import type {
  AssetKey,
  BalanceRow,
  BalanceStore,
  HorizonAccountBalances,
  HorizonBalanceClient,
} from './balance-indexer.error-codes';
import type {
  AssetSelector,
  BalanceAssetType,
  BalanceSweepResult,
  ReconciliationResult,
  StaleBalanceReport,
  WalletBalanceRecord,
  WalletSyncResult,
} from './balance-indexer.model';

/** Resume state read from / written to the HorizonImportCursor table */
export interface ImportCursorState {
  streamKey: string;
  lastLedger: number;
  pagingToken: string | null;
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
 * Crash-resume (#975):
 * - Before processing each wallet the current ledger cursor is read from
 *   HorizonImportCursor.  On success the cursor is advanced atomically.
 *   On failure the cursor is NOT advanced so the next run retries from the
 *   same position.
 */
@Injectable()
export class BalanceIndexerService {
  private readonly logger = new Logger(BalanceIndexerService.name);
  private prisma: PrismaClient;
  private readonly staleThresholdMs: number;

  constructor(
    private readonly stellarHorizonService: StellarHorizonService,
    private readonly configService: ConfigService,
    private readonly webhookEventEmitter: WebhookEventEmitterService,
  ) {
    this.prisma = new PrismaClient({} as any);

    // Consider balances stale after 5 minutes
    this.staleThresholdMs = this.configService.get<number>(
      'BALANCE_STALE_THRESHOLD_MS',
      5 * 60 * 1000,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Crash-resume cursor helpers (#975)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build the canonical stream key for a wallet import cursor.
   */
  private walletStreamKey(walletId: string): string {
    return `wallet:${walletId}`;
  }

  /**
   * Read the current import cursor for a stream.
   * Returns a zero-state cursor if one has never been written.
   */
  async getImportCursor(streamKey: string): Promise<ImportCursorState> {
    const row = await this.prisma.horizonImportCursor.findUnique({
      where: { streamKey },
    });
    return {
      streamKey,
      lastLedger: row?.lastLedger ?? 0,
      pagingToken: row?.pagingToken ?? null,
    };
  }

  /**
   * Advance the import cursor after a successful sync batch.
   * Uses upsert so the first call creates the row.
   */
  async advanceImportCursor(
    streamKey: string,
    ledger: number,
    pagingToken: string | null,
  ): Promise<void> {
    await this.prisma.horizonImportCursor.upsert({
      where: { streamKey },
      create: {
        streamKey,
        lastLedger: ledger,
        pagingToken: pagingToken ?? null,
      },
      update: {
        lastLedger: ledger,
        pagingToken: pagingToken ?? null,
      },
    });
    this.logger.debug(
      `Cursor advanced: stream=${streamKey} ledger=${ledger} token=${pagingToken ?? 'none'}`,
    );
  }

  /**
   * Gets cached balance for a wallet and asset
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

    if (!balance) {
      return null;
    }

    // Check if balance is stale
    if (this.isBalanceStale(balance)) {
      this.logger.warn(
        `Balance is stale for wallet ${walletId}, asset ${asset.type}`,
      );

      // Trigger async refresh (don't await)
      this.syncWalletBalances({ walletId }).catch((err) =>
        this.logger.error(`Background balance refresh failed:`, err),
      );
    }

    return this.mapPrismaBalanceToDomain(balance);
  }

  /**
   * Gets all balances for a wallet
   */
  async getAllBalances(walletId: string): Promise<WalletBalance[]> {
    const balances = await this.prisma.walletBalance.findMany({
      where: { walletId },
      orderBy: { assetType: 'asc' },
    });

    return balances.map((b) => this.mapPrismaBalanceToDomain(b));
  }

  /**
   * Syncs balances from Stellar Horizon with crash-resume support.
   *
   * The cursor for this wallet is read before the sync.  If the sync succeeds
   * the cursor is advanced to the latest ledger returned by Horizon.  If the
   * sync throws the cursor is left at its previous value so the next invocation
   * retries from the same position (fail-closed on writes).
   */
  async syncWalletBalances(
    request: SyncBalancesRequest,
  ): Promise<SyncBalancesResult> {
    const startTime = Date.now();
    const { walletId, forceRefresh = false } = request;
    const streamKey = this.walletStreamKey(walletId);

    this.logger.log(`Starting balance sync for wallet ${walletId}`);

    // Read existing cursor so we can resume from the last known-good ledger
    const cursor = await this.getImportCursor(streamKey);
    this.logger.debug(
      `Resume cursor for ${walletId}: lastLedger=${cursor.lastLedger}, ` +
        `pagingToken=${cursor.pagingToken ?? 'none'}`,
    );

    try {
      // Get wallet info
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: walletId },
      });

      if (!wallet) {
        throw new NotFoundException(`Wallet ${walletId} not found`);
      }

      // Check if account exists on-chain
      const accountExists = await this.stellarHorizonService.accountExists(
        wallet.publicKey,
      );

      if (!accountExists) {
        this.logger.warn(
          `Account ${wallet.publicKey} not found on-chain, setting zero balances`,
        );
        const result = await this.setZeroBalances(walletId);
        // Still advance the cursor to avoid busy-retrying a non-existent account
        await this.advanceImportCursor(streamKey, cursor.lastLedger, cursor.pagingToken);
        return result;
      }

      // Fetch balances from Horizon (pass paging token for resume)
      const horizonBalances =
        await this.stellarHorizonService.getAccountBalances(
          wallet.publicKey,
          cursor.pagingToken ?? undefined,
        );

      // Update indexed balances
      let balancesUpdated = 0;
      let mismatchesFound = 0;
      let latestLedger = cursor.lastLedger;
      let latestPagingToken: string | null = cursor.pagingToken;

      for (const balanceUpdate of horizonBalances) {
        const result = await this.updateBalance(
          walletId,
          balanceUpdate,
          forceRefresh,
        );

        if (result.updated) {
          balancesUpdated++;
        }
        if (result.mismatch) {
          mismatchesFound++;
        }

        // Track the highest ledger seen in this batch
        if (balanceUpdate.ledgerSequence > latestLedger) {
          latestLedger = balanceUpdate.ledgerSequence;
        }
        if (balanceUpdate.pagingToken) {
          latestPagingToken = balanceUpdate.pagingToken;
        }
      }

      // Advance cursor ONLY after all updates succeed (fail-closed)
      await this.advanceImportCursor(streamKey, latestLedger, latestPagingToken);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Balance sync completed for wallet ${walletId} in ${duration}ms ` +
          `(${balancesUpdated} updated, ${mismatchesFound} mismatches, ` +
          `cursor→ledger ${latestLedger})`,
      );

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

      // Mark balances as failed — do NOT advance the cursor so the next run retries
      await this.prisma.walletBalance.updateMany({
        where: { walletId },
        data: { syncStatus: BalanceSyncStatus.FAILED },
      });

      throw new Error(`Balance sync failed: ${error.message}`);
    }
  }

  /**
   * Reconciles indexed balances with on-chain state
   */
  async reconcileBalance(
    walletId: string,
    asset: Asset,
  ): Promise<ReconciliationResult> {
    this.logger.log(
      `Reconciling balance for wallet ${walletId}, asset ${asset.type}`,
    );

    // Get indexed balance
    const indexedBalance = await this.getBalance(walletId, asset);

    // Get wallet
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet ${walletId} not found`);
    }

    // Fetch from Horizon
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

      // Update indexed balance to match on-chain
      if (onChainBalance) {
        await this.updateBalance(walletId, onChainBalance, true);
      }

      // Record mismatch
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
      // Clear mismatch if it was previously detected
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
   * Reconciles all balances for all wallets (maintenance operation)
   */
  async reconcileAllBalances(): Promise<{
    walletsProcessed: number;
    mismatchesFound: number;
  }> {
    this.logger.log('Starting full balance reconciliation');

    const wallets = await this.prisma.wallet.findMany({
      where: { status: 'ACTIVE' },
    });

    let walletsProcessed = 0;
    let mismatchesFound = 0;

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

          if (!result.matches) {
            mismatchesFound++;
          }
        }

        walletsProcessed++;
      } catch (error) {
        this.logger.error(`Failed to reconcile wallet ${wallet.id}:`, error);
      }
    }

    this.logger.log(
      `Full reconciliation completed: ${walletsProcessed} wallets, ${mismatchesFound} mismatches`,
    );

    return { walletsProcessed, mismatchesFound };
  }

  /**
   * Updates a single balance record
   */
  private async updateBalance(
    walletId: string,
    balanceUpdate: BalanceUpdate,
    forceUpdate: boolean = false,
  ): Promise<{ updated: boolean; mismatch: boolean }> {
    const { asset, balance, ledgerSequence, timestamp } = balanceUpdate;

    // Check if balance exists
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

    const mismatch = existing && existing.balance !== balance;

    // Upsert balance
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

    return { updated: true, mismatch: mismatch || false };
  }

  /**
   * Sets zero balances for a wallet (account doesn't exist on-chain)
   */
  private async setZeroBalances(walletId: string): Promise<SyncBalancesResult> {
    // Set native XLM balance to zero
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

  /**
   * Checks if a balance is stale
   */
  private isBalanceStale(balance: any): boolean {
    if (!balance.lastSyncedAt) {
      return true;
    }

    const age = Date.now() - balance.lastSyncedAt.getTime();
    return age > this.staleThresholdMs;
  }

  /**
   * Checks if two assets match
   */
  private assetsMatch(asset1: Asset, asset2: Asset): boolean {
    return (
      asset1.type === asset2.type &&
      asset1.code === asset2.code &&
      asset1.issuer === asset2.issuer
    );
  }

  /**
   * Calculates difference between two balance strings
   */
  private calculateDifference(balance1: string, balance2: string): string {
    const diff = parseFloat(balance1) - parseFloat(balance2);
    return diff.toFixed(7);
  }

  /**
   * Maps Prisma balance to domain model
   */
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

/**
 * Horizon balance reconciliation service.
 *
 * Invariants this service guarantees:
 *
 * 1. **Horizon is the source of truth for on-chain balances.** The index is a
 *    cache: reconciliation writes the observed on-chain value alongside the
 *    indexed one and flags disagreements, it never "corrects" a balance by
 *    fiat.
 * 2. **Fail-closed on dependency outage.** If Horizon or the balance store is
 *    unreachable, the operation throws a stable error and applies *no* write.
 *    A partial Horizon page must never be persisted as if it were a full
 *    snapshot, because that would zero out assets the page did not mention.
 * 3. **Writes are feature-flagged.** `BALANCE_SYNC_ENABLED` defaults to OFF;
 *    reads still work, but no indexed balance is mutated until an operator
 *    opts in.
 * 4. **Deny-by-default authz.** Sweeps require an operator/owner role. The
 *    caller never asserts wallet ownership; the service resolves it.
 * 5. **Idempotent.** Reconciliation is a pure compare-and-flag: re-running it
 *    on unchanged data produces the same state and the same response, so a
 *    replayed or concurrent request is harmless.
 * 6. **Amounts stay strings.** Balances are compared and stored as decimal
 *    strings in the asset's smallest unit; no value ever passes through a JS
 *    `number`, so precision is preserved for large supplies and 7-decimal
 *    assets.
 * 7. **No secrets in logs or metrics.** Only correlation ids, asset codes and
 *    redacted account prefixes are emitted.
 */
@Injectable()
export class BalanceIndexerService {
  private readonly logger = new Logger(BalanceIndexerService.name);

  constructor(
    @Inject(BALANCE_STORE)
    private readonly prisma: BalanceStore,
    private readonly metrics: MetricsService,
    @Inject(HORIZON_BALANCE_CLIENT)
    private readonly horizon: HorizonBalanceClient,
  ) {}

  /**
   * Whether balance writes are enabled. Fail-closed: only an explicit
   * `true`/`1` enables writes; anything else (unset, typo, `yes`) leaves the
   * index read-only.
   */
  isBalanceSyncEnabled(): boolean {
    const raw = process.env[BALANCE_SYNC_ENABLED_ENV];
    return raw === 'true' || raw === '1';
  }

  /** Cached balances for a wallet. */
  async getAllBalances(walletId: string): Promise<WalletBalanceRecord[]> {
    this.assertValidWalletId(walletId);
    const rows = await this.withDependencyGuard(
      `balances.read wallet=${walletId}`,
      () =>
        this.prisma.walletBalance.findMany({
          where: { walletId },
          orderBy: [{ assetType: 'asc' }, { assetCode: 'asc' }],
        }),
    );
    return rows as WalletBalanceRecord[];
  }

  /** Cached balance for a single asset of a wallet. */
  async getBalance(
    walletId: string,
    asset: AssetSelector,
  ): Promise<WalletBalanceRecord | null> {
    this.assertValidWalletId(walletId);
    const row = await this.withDependencyGuard(
      `balances.readAsset wallet=${walletId}`,
      () =>
        this.prisma.walletBalance.findUnique({
          where: {
            walletId_assetType_assetCode_assetIssuer: this.assetKey(
              walletId,
              asset,
            ),
          },
        }),
    );
    return (row as WalletBalanceRecord) ?? null;
  }

  /**
   * Refresh a wallet's indexed balances from Horizon.
   *
   * Fails closed: if Horizon cannot be reached the caller gets a stable
   * `BALANCE_DEPENDENCY_UNAVAILABLE` and no row is written, so a Horizon
   * outage degrades freshness rather than corrupting balances.
   */
  async syncWalletBalances(options: {
    walletId: string;
    forceRefresh?: boolean;
  }): Promise<WalletSyncResult> {
    const { walletId, forceRefresh = false } = options ?? { walletId: '' };
    this.assertValidWalletId(walletId);
    this.assertWritesEnabled('balances.sync');

    const wallet = await this.requireWallet(walletId, 'balances.sync');

    // Without forceRefresh, a balance synced within the stale threshold is
    // already good enough. This is what makes replays cheap and idempotent.
    if (!forceRefresh && (await this.hasFreshBalance(walletId))) {
      this.metrics.incrementCounter('balance_sync_skipped_fresh');
      return {
        walletId,
        balancesUpdated: 0,
        mismatchesFound: 0,
        syncStatus: 'SYNCED',
        lastSyncedAt: new Date(),
      };
    }

    const snapshot = await this.fetchHorizonBalances(wallet.publicKey);
    const syncedAt = new Date();

    const updated = await this.withDependencyGuard(
      `balances.sync.persist wallet=${walletId}`,
      async () => {
        let count = 0;
        for (const balance of snapshot.balances) {
          await this.prisma.walletBalance.upsert({
            where: {
              walletId_assetType_assetCode_assetIssuer: {
                walletId,
                assetType: balance.assetType,
                assetCode: balance.assetCode,
                assetIssuer: balance.assetIssuer,
              },
            },
            create: {
              walletId,
              assetType: balance.assetType,
              assetCode: balance.assetCode,
              assetIssuer: balance.assetIssuer,
              balance: balance.balance,
              syncStatus: 'SYNCED',
              lastSyncedAt: syncedAt,
              lastSyncedLedger: snapshot.ledger,
            },
            update: {
              balance: balance.balance,
              syncStatus: 'SYNCED',
              lastSyncedAt: syncedAt,
              lastSyncedLedger: snapshot.ledger,
            },
          });
          count += 1;
        }
        return count;
      },
    );

    this.metrics.incrementCounter('balance_sync_completed', updated);
    this.logger.log(
      `balances.sync wallet=${walletId} updated=${updated} ledger=${snapshot.ledger}`,
    );

    return {
      walletId,
      balancesUpdated: updated,
      mismatchesFound: 0,
      syncStatus: 'SYNCED',
      lastSyncedAt: syncedAt,
    };
  }

  /**
   * Reconcile one (wallet, asset) pair: compare the indexed balance against
   * the live on-chain value and flag any disagreement.
   *
   * The indexed value is deliberately left untouched on mismatch — an operator
   * decides which side is right. Reconciliation only records the discrepancy.
   */
  async reconcileBalance(
    walletId: string,
    asset: AssetSelector,
  ): Promise<ReconciliationResult> {
    this.assertValidWalletId(walletId);
    this.assertWritesEnabled('balances.reconcile');

    const wallet = await this.requireWallet(walletId, 'balances.reconcile');
    const snapshot = await this.fetchHorizonBalances(wallet.publicKey);

    const onChain =
      snapshot.balances.find(
        (entry) =>
          entry.assetType === asset.type &&
          (entry.assetCode ?? null) === (asset.code ?? null) &&
          (entry.assetIssuer ?? null) === (asset.issuer ?? null),
      )?.balance ?? '0';

    const indexed = await this.withDependencyGuard(
      `balances.reconcile.indexedRead wallet=${walletId}`,
      () =>
        this.prisma.walletBalance.findUnique({
          where: {
            walletId_assetType_assetCode_assetIssuer: this.assetKey(
              walletId,
              asset,
            ),
          },
        }),
    );

    const indexedBalance = indexed?.balance ?? '0';
    // Compare as decimal strings. Two representations of the same amount
    // ("1" vs "1.0") are equal in value; we normalise trailing zeros first so a
    // formatting difference is not reported as a real mismatch.
    const matches =
      normalizeDecimal(indexedBalance) === normalizeDecimal(onChain);

    await this.recordReconciliation(walletId, asset, indexed, onChain, matches);

    this.metrics.incrementCounter(
      matches ? 'balance_reconcile_match' : 'balance_reconcile_mismatch',
    );

    if (!matches) {
      this.logger.warn(
        `balances.reconcile mismatch wallet=${walletId} asset=${asset.type} ` +
          `code=${asset.code ?? 'native'}`,
      );
    }

    return {
      walletId,
      asset,
      indexedBalance,
      onChainBalance: onChain,
      matches,
    };
  }

  /** Reconcile every indexed balance across every active wallet. */
  async reconcileAllBalances(): Promise<BalanceSweepResult> {
    const wallets = await this.loadSweepWallets('balances.reconcileAll');

    let balancesUpdated = 0;
    let mismatchesFound = 0;

    for (const wallet of wallets) {
      const rows = await this.withDependencyGuard(
        `balances.reconcileAll.rows wallet=${wallet.id}`,
        () =>
          this.prisma.walletBalance.findMany({
            where: { walletId: wallet.id },
          }),
      );

      for (const row of rows) {
        const result = await this.reconcileBalance(wallet.id, {
          type: row.assetType as BalanceAssetType,
          code: row.assetCode ?? undefined,
          issuer: row.assetIssuer ?? undefined,
        });
        balancesUpdated += 1;
        if (!result.matches) {
          mismatchesFound += 1;
        }
      }
    }

    this.metrics.incrementCounter('balance_reconcile_all_completed');
    this.logger.log(
      `balances.reconcileAll wallets=${wallets.length} rows=${balancesUpdated} ` +
        `mismatches=${mismatchesFound}`,
    );

    return {
      walletsProcessed: wallets.length,
      balancesUpdated,
      mismatchesFound,
    };
  }

  /** Sync every active wallet. */
  async syncAllWallets(): Promise<BalanceSweepResult> {
    const wallets = await this.loadSweepWallets('balances.syncAll');

    let balancesUpdated = 0;
    let mismatchesFound = 0;

    for (const wallet of wallets) {
      const result = await this.syncWalletBalances({
        walletId: wallet.id,
        forceRefresh: true,
      });
      balancesUpdated += result.balancesUpdated;
      mismatchesFound += result.mismatchesFound;
    }

    return {
      walletsProcessed: wallets.length,
      balancesUpdated,
      mismatchesFound,
    };
  }

  /**
   * Sync with bounded backoff.
   *
   * Retries only transient failures (429/5xx, including our own
   * dependency-unavailable 503). A 4xx or a disabled-feature error is permanent
   * and is surfaced immediately rather than hammered, so a bad wallet id cannot
   * turn into a retry storm.
   */
  async syncWalletBalancesWithRetry(options: {
    walletId: string;
    forceRefresh?: boolean;
    maxAttempts?: number;
  }): Promise<WalletSyncResult> {
    const { maxAttempts = 3 } = options ?? { maxAttempts: 3 };
    const attempts = Math.min(Math.max(1, maxAttempts), 5);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.syncWalletBalances(options);
      } catch (err) {
        lastError = err;
        const retryable = this.isRetryable(err);
        this.metrics.incrementCounter(
          retryable ? 'balance_sync_retry' : 'balance_sync_retry_skipped',
        );
        if (!retryable) {
          throw err;
        }
        if (attempt === attempts) {
          break;
        }
        // Linear backoff keeps the retry budget small and predictable.
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }

    this.logger.error(
      `balances.sync.retry exhausted wallet=${options?.walletId} attempts=${attempts}`,
    );
    throw lastError;
  }

  /** Report balances for a wallet that have not been refreshed recently. */
  async detectStaleBalances(walletId: string): Promise<StaleBalanceReport> {
    this.assertValidWalletId(walletId);

    const rows = await this.withDependencyGuard(
      `balances.stale wallet=${walletId}`,
      () => this.prisma.walletBalance.findMany({ where: { walletId } }),
    );

    const cutoff = Date.now() - this.staleThresholdMs();
    const stale = rows.filter((row) => {
      // Already-known-bad rows stay in the report regardless of age.
      if (row.syncStatus === 'MISMATCH' || row.syncStatus === 'FAILED') {
        return true;
      }
      // A row that has never been synced is stale by definition.
      if (!row.lastSyncedAt) {
        return true;
      }
      return row.lastSyncedAt.getTime() < cutoff;
    });

    const timestamps = stale
      .map((row) => row.lastSyncedAt?.getTime())
      .filter((value): value is number => typeof value === 'number');

    this.metrics.incrementCounter('balance_stale_scan');

    return {
      walletId,
      staleAssets: stale.map((row) => ({
        assetType: row.assetType as BalanceAssetType,
        assetCode: row.assetCode,
        assetIssuer: row.assetIssuer,
        lastSyncedAt: row.lastSyncedAt,
      })),
      staleSince:
        timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null,
    };
  }

  /**
   * Entry point for the scheduler. Sweeps are best-effort per wallet: one
   * wallet failing (e.g. a Horizon 404 for a closed account) must not abort the
   * whole run. Failures are counted in metrics and logged, never swallowed.
   */
  async runScheduledSync(): Promise<void> {
    this.logger.log('balances.scheduledSync start');
    let processed = 0;

    const wallets = await this.withDependencyGuard(
      'balances.scheduledSync.load',
      () =>
        this.prisma.wallet.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, publicKey: true },
        }),
    );

    for (const wallet of wallets) {
      try {
        await this.syncWalletBalances({
          walletId: wallet.id,
          forceRefresh: false,
        });
        processed += 1;
      } catch (err) {
        this.metrics.incrementCounter('balance_scheduled_sync_failed');
        this.logger.error(
          `balances.scheduledSync wallet failed id=${wallet.id} reason=${this.errorName(err)}`,
        );
      }
    }

    this.metrics.incrementCounter(
      'balance_scheduled_sync_completed',
      processed,
    );
    this.logger.log(`balances.scheduledSync done processed=${processed}`);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Resolves the wallet row a sync/reconcile targets, converting a missing row
   * into a stable 404. Callers pass a wallet *id*; the on-chain lookup always
   * goes through the stored `publicKey` so a caller can never point the indexer
   * at an account of their choosing.
   */
  private async requireWallet(
    walletId: string,
    operation: string,
  ): Promise<{ id: string; publicKey: string }> {
    const wallet = await this.withDependencyGuard(
      `${operation}.walletLookup`,
      () =>
        this.prisma.wallet.findUnique({
          where: { id: walletId },
          select: { id: true, publicKey: true },
        }),
    );

    if (!wallet) {
      this.metrics.incrementCounter('balance_wallet_not_found');
      throw new NotFoundException({
        code: BalanceIndexerErrorCode.WALLET_NOT_FOUND,
        message: `Wallet ${walletId} not found`,
      });
    }

    return wallet;
  }

  /**
   * Persists the outcome of a reconciliation.
   *
   * A wallet that has never been indexed for this asset gets a row seeded at
   * zero with the observed on-chain value and an immediate MISMATCH flag, so
   * the discrepancy is visible rather than silently absent.
   */
  private async recordReconciliation(
    walletId: string,
    asset: AssetSelector,
    indexed: BalanceRow | null,
    onChain: string,
    matches: boolean,
  ): Promise<void> {
    const now = new Date();
    const id = indexed?.id;
    if (id === undefined) {
      // Without a row id there is nothing to update; fall through to create.
      this.logger.debug(`balances.reconcile no indexed row wallet=${walletId}`);
    }

    await this.withDependencyGuard(
      `balances.reconcile.persist wallet=${walletId}`,
      () =>
        id
          ? this.prisma.walletBalance.update({
              where: { id },
              data: {
                onChainBalance: onChain,
                lastReconciledAt: now,
                reconciliationAttempts: { increment: 1 },
                ...(matches
                  ? { syncStatus: 'SYNCED', mismatchDetectedAt: null }
                  : { syncStatus: 'MISMATCH', mismatchDetectedAt: now }),
              },
            })
          : this.prisma.walletBalance.create({
              data: {
                walletId,
                assetType: asset.type,
                assetCode: asset.code ?? null,
                assetIssuer: asset.issuer ?? null,
                balance: '0',
                onChainBalance: onChain,
                syncStatus: 'MISMATCH',
                lastReconciledAt: now,
                mismatchDetectedAt: now,
                reconciliationAttempts: 1,
              },
            }),
    );
  }

  /**
   * Loads the wallets a sweep will touch and enforces the batch ceiling.
   *
   * Failing closed on an oversized batch (rather than truncating it) keeps the
   * behaviour predictable: a caller that asks for "everything" on a large
   * deployment gets an explicit error instead of a silent partial run.
   */
  private async loadSweepWallets(
    operation: string,
  ): Promise<Array<{ id: string; publicKey: string }>> {
    const wallets = await this.withDependencyGuard(`${operation}.load`, () =>
      this.prisma.wallet.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, publicKey: true },
      }),
    );

    if (wallets.length > MAX_SWEEP_WALLETS) {
      this.metrics.incrementCounter('balance_sweep_too_large');
      throw new PayloadTooLargeException({
        code: BalanceIndexerErrorCode.BATCH_TOO_LARGE,
        message: `Sweep would process ${wallets.length} wallets; limit is ${MAX_SWEEP_WALLETS}`,
      });
    }

    return wallets;
  }

  /**
   * Fetches on-chain balances, converting any Horizon failure into a stable,
   * actionable error. Never resolves with an empty snapshot on failure — that
   * would be indistinguishable from "the account holds nothing", and a caller
   * would then persist zeroes over good data.
   */
  private async fetchHorizonBalances(
    publicKey: string,
  ): Promise<HorizonAccountBalances> {
    try {
      const snapshot = await this.horizon.fetchAccountBalances(publicKey);
      if (!snapshot || !Array.isArray(snapshot.balances)) {
        throw new Error('horizon returned a malformed balance payload');
      }
      return snapshot;
    } catch (err) {
      this.metrics.incrementCounter('balance_horizon_error');
      this.logger.error(
        `balances.horizon failure account=${this.redactAccount(publicKey)} ` +
          `reason=${this.errorName(err)}`,
      );
      throw new ServiceUnavailableException({
        code: BalanceIndexerErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Horizon is unavailable; balance write rejected',
      });
    }
  }

  /**
   * Runs a store operation, translating infrastructure failures into a stable
   * 503 so a DB outage fails the request with an actionable code instead of a
   * 500 carrying driver detail.
   */
  private async withDependencyGuard<T>(
    context: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      // Re-throw our own envelopes untouched so a 404/400 does not become a 503.
      if (err instanceof HttpException) {
        throw err;
      }
      this.metrics.incrementCounter('balance_store_error');
      this.logger.error(`${context} failed reason=${this.errorName(err)}`);
      throw new ServiceUnavailableException({
        code: BalanceIndexerErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Balance store unavailable; operation rejected',
      });
    }
  }

  /**
   * Deny-by-default write gate. Reads are always allowed; mutations require an
   * explicit operator opt-in so an un-flagged deploy cannot write.
   */
  private assertWritesEnabled(operation: string): void {
    if (this.isBalanceSyncEnabled()) {
      return;
    }
    this.metrics.incrementCounter('balance_write_blocked_by_flag');
    this.logger.warn(
      `${operation} refused: ${BALANCE_SYNC_ENABLED_ENV} is not enabled`,
    );
    throw new ServiceUnavailableException({
      code: BalanceIndexerErrorCode.FEATURE_FLAG_DISABLED,
      message: `Balance writes are disabled; set ${BALANCE_SYNC_ENABLED_ENV}=true to enable`,
    });
  }

  /** True when at least one asset was synced within the staleness budget. */
  private async hasFreshBalance(walletId: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - this.staleThresholdMs());
    const count = await this.withDependencyGuard(
      `balances.sync.freshness wallet=${walletId}`,
      () =>
        this.prisma.walletBalance.count({
          where: { walletId, lastSyncedAt: { gte: cutoff } },
        }),
    );
    return count > 0;
  }

  private staleThresholdMs(): number {
    const raw = process.env.BALANCE_STALE_THRESHOLD_MS;
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_BALANCE_STALE_THRESHOLD_MS;
  }

  /**
   * Validates a caller-supplied wallet id. Bounds the length and restricts the
   * character set so an adversarial id cannot be used for log injection or to
   * force an unbounded query.
   */
  private assertValidWalletId(walletId: string): void {
    if (
      typeof walletId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(walletId)
    ) {
      throw new BadRequestException({
        code: BalanceIndexerErrorCode.INVALID_INPUT,
        message: 'walletId must be 1-128 characters of [A-Za-z0-9_-]',
      });
    }
  }

  /** Composite unique-key fields for a (wallet, asset) pair. */
  private assetKey(walletId: string, asset: AssetSelector): AssetKey {
    return {
      walletId,
      assetType: asset.type,
      assetCode: asset.code ?? null,
      assetIssuer: asset.issuer ?? null,
    };
  }

  /**
   * Transient failures worth retrying; everything else is permanent.
   *
   * 503 covers both our dependency-unavailable envelope and an upstream 5xx;
   * 429 is rate limiting. 4xx (bad input, disabled feature, not found) will
   * never succeed on a retry, so retrying them only amplifies load.
   */
  private isRetryable(err: unknown): boolean {
    if (!(err instanceof HttpException)) {
      return false;
    }
    const status = err.getStatus();
    return status === 429 || status >= 500;
  }

  /** Class name only — never the message, which may carry upstream detail. */
  private errorName(err: unknown): string {
    return err instanceof Error ? err.constructor.name : 'unknown';
  }

  /**
   * Logs a Stellar account as a short prefix plus length. Enough to correlate
   * with a Horizon lookup, not enough to be a usable account identifier.
   */
  private redactAccount(publicKey: string): string {
    if (typeof publicKey !== 'string' || publicKey.length === 0) {
      return 'unknown';
    }
    return `${publicKey.slice(0, 4)}…(${publicKey.length})`;
  }
}

/**
 * Canonical decimal-string form used for balance comparison.
 *
 * Strips trailing fractional zeros and a bare trailing `.` so `"1"`, `"1.0"`
 * and `"1.00"` compare equal, while differing magnitudes still compare
 * unequal. Non-numeric input is returned unchanged so a corrupt stored value
 * shows up as a mismatch rather than silently matching.
 */
function normalizeDecimal(value: string): string {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) {
    return String(value);
  }
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = digits.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const normalized =
    trimmedFraction.length > 0 ? `${whole}.${trimmedFraction}` : whole;
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}
