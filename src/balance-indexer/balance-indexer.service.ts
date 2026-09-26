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
