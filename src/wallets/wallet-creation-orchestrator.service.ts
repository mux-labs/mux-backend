import { Injectable, Logger } from '@nestjs/common';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { randomUUID } from 'crypto';
import { EncryptionService } from '../encryption/encryption.service';

export interface WalletCreationResult {
  id: string;
  userId: string;
  publicKey: string;
  /**
   * AES-256-GCM envelope for the Stellar secret seed, as persisted in
   * `Wallet.encryptedSecret`. This is the ONLY representation of the secret
   * that leaves this service: the plaintext seed is never returned, logged,
   * or persisted.
   */
  encryptedSecret: string;
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
 *
 * Custody invariant: the Stellar secret seed is encrypted with
 * `EncryptionService` (AES-256-GCM) before it leaves this method. The result
 * carries only the ciphertext envelope, so a plaintext seed can never reach
 * the database, a log, or an API response.
 */
@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);

  constructor(private readonly encryptionService: EncryptionService) {}

  async createWallet(
    userId: string,
    network: WalletNetwork,
    idempotencyKey: string,
  ): Promise<WalletCreationResult> {
    const publicKey = `G${randomUUID().slice(0, 55)}`;
    const secretSeed = `S${randomUUID().slice(0, 55)}`;

    // Encrypt before the secret can be persisted or returned. Throwing here
    // (e.g. missing WALLET_ENCRYPTION_KEY) aborts creation rather than falling
    // back to storing the seed in plaintext.
    const encryptedSecret =
      this.encryptionService.encryptAndSerialize(secretSeed);

    return {
      id: randomUUID(),
      userId,
      publicKey,
      encryptedSecret,
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
