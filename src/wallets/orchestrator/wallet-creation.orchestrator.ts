import { Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Keypair } from '@stellar/stellar-sdk';
import * as CryptoJS from 'crypto-js';

export interface CreateWalletRequest {
  userId: string;
  encryptionKey: string;
}

export interface CreateWalletResponse {
  walletId: string;
  publicKey: string;
  userId: string;
}

@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);

  constructor(private readonly prisma: PrismaService) {}

  async createWallet(request: CreateWalletRequest): Promise<CreateWalletResponse> {
    const { userId, encryptionKey } = request;

    this.logger.log(`Starting wallet creation for user: ${userId}`);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Step 1: Resolve internal user
        const user = await this.resolveUser(userId, tx);
        
        // Step 2: Check if wallet already exists (idempotency)
        const existingWallet = await this.findWalletByUserId(userId, tx);
        if (existingWallet) {
          this.logger.log(`Wallet already exists for user: ${userId}`);
          return {
            walletId: existingWallet.id,
            publicKey: existingWallet.publicKey,
            userId: existingWallet.userId,
          };
        }

        // Step 3: Generate keypair
        const keypair = await this.generateKeypair();
        
        // Step 4: Encrypt and persist wallet
        const wallet = await this.persistWallet({
          userId,
          publicKey: keypair.publicKey(),
          secretKey: keypair.secret(),
          encryptionKey,
        }, tx);

        this.logger.log(`Successfully created wallet for user: ${userId}, walletId: ${wallet.id}`);

        return {
          walletId: wallet.id,
          publicKey: wallet.publicKey,
          userId: wallet.userId,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to create wallet for user: ${userId}`, error);
      throw error;
    }
  }

  private async resolveUser(userId: string, tx: any): Promise<any> {
    const user = await tx.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return user;
  }

  private async findWalletByUserId(userId: string, tx: any): Promise<any> {
    return await tx.wallet.findUnique({
      where: { userId },
    });
  }

  private async generateKeypair(): Promise<Keypair> {
    // Generate a new Stellar keypair
    const keypair = Keypair.random();
    
    this.logger.debug(`Generated new keypair with public key: ${keypair.publicKey()}`);
    
    return keypair;
  }

  private async persistWallet(
    walletData: {
      userId: string;
      publicKey: string;
      secretKey: string;
      encryptionKey: string;
    },
    tx: any
  ): Promise<any> {
    const { userId, publicKey, secretKey, encryptionKey } = walletData;

    // Encrypt the secret key
    const encryptedKey = this.encryptSecretKey(secretKey, encryptionKey);

    // Create wallet record
    const wallet = await tx.wallet.create({
      data: {
        userId,
        publicKey,
        encryptedKey,
      },
    });

    this.logger.debug(`Persisted wallet with ID: ${wallet.id}`);
    
    return wallet;
  }

  private encryptSecretKey(secretKey: string, encryptionKey: string): string {
    try {
      const encrypted = CryptoJS.AES.encrypt(secretKey, encryptionKey).toString();
      this.logger.debug(`Successfully encrypted secret key`);
      return encrypted;
    } catch (error) {
      this.logger.error('Failed to encrypt secret key', error);
      throw new Error('Failed to encrypt wallet secret key');
    }
  }

  async getWalletByUserId(userId: string): Promise<any> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      include: { user: true },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet for user ${userId} not found`);
    }

    return wallet;
  }

  async decryptSecretKey(encryptedKey: string, encryptionKey: string): Promise<string> {
    try {
      const decrypted = CryptoJS.AES.decrypt(encryptedKey, encryptionKey);
      const secretKey = decrypted.toString(CryptoJS.enc.Utf8);
      
      if (!secretKey) {
        throw new Error('Failed to decrypt secret key - invalid encryption key');
      }
      
      return secretKey;
    } catch (error) {
      this.logger.error('Failed to decrypt secret key', error);
      throw new Error('Failed to decrypt wallet secret key');
    }
  }
}
