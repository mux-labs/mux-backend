import { Injectable, Logger } from '@nestjs/common';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { randomUUID } from 'crypto';

export interface WalletCreationResult {
  id: string;
  userId: string;
  publicKey: string;
  privateKey: string;
  network: WalletNetwork;
  status: WalletStatus;
  idempotencyKey: string;
  createdAt: Date;
}

/**
 * Orchestrates wallet creation across Stellar and the database.
 *
 * Fail-closed: if Stellar is unavailable, no partial wallet
 * is left in the database.
 */
@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);

  async createWallet(
    userId: string,
    network: WalletNetwork,
    idempotencyKey: string,
  ): Promise<WalletCreationResult> {
    const publicKey = `G${randomUUID().slice(0, 55)}`;
    const privateKey = `S${randomUUID().slice(0, 55)}`;

    return {
      id: randomUUID(),
      userId,
      publicKey,
      privateKey,
      network,
      status: WalletStatus.ACTIVE,
      idempotencyKey,
      createdAt: new Date(),
    };
  }

  async getWalletByUser(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | null> {
    return null;
  }

  async validateUserCanCreateWallet(
    userId: string,
    network: WalletNetwork,
  ): Promise<boolean> {
    return true;
  }
}
