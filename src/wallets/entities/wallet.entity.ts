import { WalletNetwork, WalletStatus } from '../domain/wallet.model';

/**
 * Persistence-ready Wallet shape for this module.
 *
 * Note: This is intentionally chain-agnostic (no Stellar-specific fields/logic).
 */
export class Wallet {
  id: string;
  userId: string;

  publicKey: string;
  encryptedSecret: string;

  encryptionVersion: number;
  secretVersion: number;

  network: WalletNetwork;
  status: WalletStatus;
  statusReason?: string | null;
  statusChangedAt: Date;

  rotatedFromId?: string | null;

  createdAt: Date;
  updatedAt: Date;
}
