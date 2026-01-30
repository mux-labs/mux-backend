import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { StellarHorizonService } from './stellar-horizon.service';
import { ConfigService } from '@nestjs/config';
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

/**
 * Balance Indexer Service
 *
 * Responsibilities:
 * - Index wallet balances from Stellar Horizon
 * - Provide fast balance queries without hitting the blockchain
 * - Detect and reconcile balance mismatches
 * - Handle missed updates and recovery
 */
@Injectable()
export class BalanceIndexerService {
  private readonly logger = new Logger(BalanceIndexerService.name);
  private prisma: PrismaClient;
  private readonly staleThresholdMs: number;

  constructor(
    private readonly stellarHorizonService: StellarHorizonService,
    private readonly configService: ConfigService,
  ) {
    this.prisma = new PrismaClient({} as any);

    // Consider balances stale after 5 minutes
    this.staleThresholdMs = this.configService.get<number>(
      'BALANCE_STALE_THRESHOLD_MS',
      5 * 60 * 1000,
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
   * Syncs balances from Stellar Horizon
   */
  async syncWalletBalances(
    request: SyncBalancesRequest,
  ): Promise<SyncBalancesResult> {
    const startTime = Date.now();
    const { walletId, forceRefresh = false } = request;

    this.logger.log(`Starting balance sync for wallet ${walletId}`);

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
        return await this.setZeroBalances(walletId);
      }

      // Fetch balances from Horizon
      const horizonBalances =
        await this.stellarHorizonService.getAccountBalances(wallet.publicKey);

      // Update indexed balances
      let balancesUpdated = 0;
      let mismatchesFound = 0;

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
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Balance sync completed for wallet ${walletId} in ${duration}ms ` +
          `(${balancesUpdated} updated, ${mismatchesFound} mismatches)`,
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

      // Mark balances as failed
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
