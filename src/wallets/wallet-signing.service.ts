import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletCreationOrchestrator } from './orchestrator/wallet-creation.orchestrator';
import { Keypair, Transaction } from '@stellar/stellar-sdk';

export interface SigningRequest {
  userId: string;
  transaction: Transaction;
}

export interface SigningResult {
  signedTransaction: string;
  success: boolean;
  error?: string;
}

@Injectable()
export class WalletSigningService {
  private readonly logger = new Logger(WalletSigningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletCreationOrchestrator: WalletCreationOrchestrator
  ) {}

  /**
   * Sign a transaction using the user's encrypted private key
   * This is the only place where private keys are decrypted
   */
  async signTransaction(request: SigningRequest): Promise<SigningResult> {
    const { userId, transaction } = request;

    this.logger.log(`Starting transaction signing for user: ${userId}`);

    try {
      // Step 1: Retrieve the user's wallet
      const wallet = await this.walletCreationOrchestrator.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new NotFoundException(`Wallet not found for user: ${userId}`);
      }

      // Step 2: Decrypt the private key (only when signing)
      const decryptedSecretKey = await this.walletCreationOrchestrator.decryptSecretKey(
        wallet.encryptedKey
      );

      // Step 3: Create keypair from decrypted secret key
      const keypair = Keypair.fromSecret(decryptedSecretKey);

      // Step 4: Sign the transaction
      transaction.sign(keypair);

      // Step 5: Return the signed transaction as base64
      const signedTransaction = transaction.toXDR();

      this.logger.log(`Successfully signed transaction for user: ${userId}`);

      return {
        signedTransaction,
        success: true,
      };
    } catch (error) {
      this.logger.error(`Failed to sign transaction for user: ${userId}`, error);
      
      return {
        signedTransaction: '',
        success: false,
        error: `Transaction signing failed: ${error.message}`,
      };
    }
  }

  /**
   * Verify a wallet's private key can be decrypted (health check)
   */
  async verifyWalletIntegrity(userId: string): Promise<boolean> {
    try {
      const wallet = await this.walletCreationOrchestrator.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new NotFoundException(`Wallet not found for user: ${userId}`);
      }

      // Attempt decryption - this will fail if key is corrupted
      await this.walletCreationOrchestrator.decryptSecretKey(wallet.encryptedKey);
      
      this.logger.debug(`Wallet integrity verified for user: ${userId}`);
      return true;
    } catch (error) {
      this.logger.error(`Wallet integrity check failed for user: ${userId}`, error);
      return false;
    }
  }

  /**
   * Batch verify multiple wallets (for maintenance)
   */
  async batchVerifyWalletIntegrity(userIds: string[]): Promise<{[userId: string]: boolean}> {
    const results: {[userId: string]: boolean} = {};
    
    for (const userId of userIds) {
      results[userId] = await this.verifyWalletIntegrity(userId);
    }
    
    return results;
  }
}
