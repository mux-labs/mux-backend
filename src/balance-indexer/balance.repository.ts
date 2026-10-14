import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import {
  WalletBalance,
  Asset,
  AssetType,
  BalanceSyncStatus,
  BalanceUpdate,
} from './domain/balance.model';

/**
 * Data-access layer for wallet balances.
 *
 * Encapsulates all Prisma calls so that BalanceIndexerService operates on
 * domain types only, never on raw Prisma row shapes. This is the single
 * location that owns the balance ↔ database mapping.
 */
@Injectable()
export class BalanceRepository {
  private readonly prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient(undefined);
  }

  async findOne(walletId: string, asset: Asset): Promise<WalletBalance | null> {
    const row = await this.prisma.walletBalance.findUnique({
      where: {
        walletId_assetType_assetCode_assetIssuer: {
          walletId,
          assetType: asset.type,
          assetCode: asset.code ?? null,
          assetIssuer: asset.issuer ?? null,
        },
      },
    });
    return row ? this.toDomain(row) : null;
  }

  async findAll(walletId: string): Promise<WalletBalance[]> {
    const rows = await this.prisma.walletBalance.findMany({
      where: { walletId },
      orderBy: { assetType: 'asc' },
    });
    return rows.map((r) => this.toDomain(r));
  }

  async upsert(walletId: string, update: BalanceUpdate): Promise<void> {
    const { asset, balance, ledgerSequence, timestamp } = update;
    await this.prisma.walletBalance.upsert({
      where: {
        walletId_assetType_assetCode_assetIssuer: {
          walletId,
          assetType: asset.type,
          assetCode: asset.code ?? null,
          assetIssuer: asset.issuer ?? null,
        },
      },
      create: {
        walletId,
        assetType: asset.type,
        assetCode: asset.code ?? null,
        assetIssuer: asset.issuer ?? null,
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
  }

  async upsertNativeZero(walletId: string): Promise<void> {
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
  }

  async markFailed(walletId: string): Promise<void> {
    await this.prisma.walletBalance.updateMany({
      where: { walletId },
      data: { syncStatus: BalanceSyncStatus.FAILED },
    });
  }

  async recordMismatch(walletId: string, asset: Asset): Promise<void> {
    await this.prisma.walletBalance.updateMany({
      where: {
        walletId,
        assetType: asset.type,
        assetCode: asset.code ?? null,
        assetIssuer: asset.issuer ?? null,
      },
      data: {
        mismatchDetectedAt: new Date(),
        reconciliationAttempts: { increment: 1 },
      },
    });
  }

  async clearMismatch(walletId: string, asset: Asset): Promise<void> {
    await this.prisma.walletBalance.updateMany({
      where: {
        walletId,
        assetType: asset.type,
        assetCode: asset.code ?? null,
        assetIssuer: asset.issuer ?? null,
      },
      data: {
        mismatchDetectedAt: null,
        lastReconciledAt: new Date(),
      },
    });
  }

  async findWallet(
    walletId: string,
  ): Promise<{ id: string; publicKey: string; status: string } | null> {
    return this.prisma.wallet.findUnique({ where: { id: walletId } });
  }

  async findActiveWallets(): Promise<
    Array<{ id: string; publicKey: string; status: string }>
  > {
    return this.prisma.wallet.findMany({ where: { status: 'ACTIVE' } });
  }

  private toDomain(row: any): WalletBalance {
    return {
      id: row.id,
      walletId: row.walletId,
      assetType: row.assetType as AssetType,
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
      balance: row.balance,
      syncStatus: row.syncStatus as BalanceSyncStatus,
      lastSyncedAt: row.lastSyncedAt,
      lastSyncedLedger: row.lastSyncedLedger,
      lastReconciledAt: row.lastReconciledAt,
      reconciliationAttempts: row.reconciliationAttempts,
      onChainBalance: row.onChainBalance,
      mismatchDetectedAt: row.mismatchDetectedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
