import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import { WalletNetwork, WalletStatus, Wallet } from './domain/wallet.model';
import { EncryptionService, DecryptionError } from '../encryption/encryption.service';
import * as crypto from 'crypto';

export interface CreateWalletRequest {
  userId: string;
  network: WalletNetwork;
}

export interface WalletCreationResult {
  wallet: Wallet;
  privateKey: string; // Only returned during creation for immediate use
}

export interface SigningResult {
  signature: string;
  transactionHash?: string;
}

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);
  private prisma: PrismaClient;

  constructor(
    private encryptionService: EncryptionService,
    private configService: ConfigService,
  ) {
    this.prisma = new PrismaClient(undefined);
  }

  async onModuleInit() {
    // Validate encryption configuration on startup
    if (!this.encryptionService.validateConfiguration()) {
      throw new Error('Wallet encryption service configuration is invalid');
    }
    this.logger.log('Wallet service initialized with encryption validation passed');
  }

  /**
   * Creates a new wallet with encrypted private key storage
   */
  async createWallet(request: CreateWalletRequest): Promise<WalletCreationResult> {
    const { userId, network } = request;

    // Check if user already has a wallet on this network
    const existingWallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });

    if (existingWallet) {
      throw new ConflictException(`User already has a wallet on ${network}`);
    }

    // Generate new keypair
    const keyPair = this.generateStellarKeyPair();
    
    // Encrypt the private key before storage
    const encryptedSecret = this.encryptionService.encryptAndSerialize(keyPair.privateKey);

    try {
      const createdWallet = await this.prisma.wallet.create({
        data: {
          userId,
          publicKey: keyPair.publicKey,
          encryptedSecret,
          network,
          status: 'ACTIVE',
          encryptionVersion: 1,
          secretVersion: 1,
        },
      });

      this.logger.log(`Created new wallet for user ${userId} on ${network}`);

      return {
        wallet: this.mapPrismaWalletToDomain(createdWallet),
        privateKey: keyPair.privateKey, // Return only for immediate use
      };
    } catch (error) {
      this.logger.error('Failed to create wallet:', error);
      throw new Error('Wallet creation failed');
    }
  }

  /**
   * Retrieves a wallet by ID (without decrypting the private key)
   */
  async findWalletById(walletId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    return this.mapPrismaWalletToDomain(wallet);
  }

  /**
   * Retrieves a wallet by user and network (without decrypting the private key)
   */
  async findWalletByUser(userId: string, network: WalletNetwork): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet for user ${userId} on ${network} not found`);
    }

    return this.mapPrismaWalletToDomain(wallet);
  }

  /**
   * Retrieves and decrypts private key for signing operations
   */
  async getDecryptedPrivateKey(walletId: string): Promise<string> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    if (wallet.status !== 'ACTIVE') {
      throw new Error(`Cannot sign with wallet in status: ${wallet.status}`);
    }

    try {
      const privateKey = this.encryptionService.deserializeAndDecrypt(wallet.encryptedSecret);
      this.logger.log(`Successfully decrypted private key for wallet ${walletId}`);
      return privateKey;
    } catch (error) {
      if (error && (error as any).code && ['DECRYPTION_FAILED', 'INVALID_KEY', 'INVALID_DATA'].includes((error as any).code)) {
        this.logger.error(`Decryption failed for wallet ${walletId}:`, error);
        throw new Error('Wallet key decryption failed - possible data corruption');
      }
      this.logger.error(`Unexpected error decrypting wallet ${walletId}:`, error);
      throw new Error('Failed to access wallet private key');
    }
  }

  /**
   * Signs a transaction using the wallet's private key
   */
  async signTransaction(walletId: string, transactionData: string): Promise<SigningResult> {
    try {
      const privateKey = await this.getDecryptedPrivateKey(walletId);
      
      // For Stellar, we would use the SDK to sign
      // This is a simplified example - in production you'd use stellar-sdk
      const signature = this.signWithPrivateKey(privateKey, transactionData);
      
      this.logger.log(`Successfully signed transaction with wallet ${walletId}`);
      
      return {
        signature,
        // transactionHash would be calculated based on the signed transaction
      };
    } catch (error) {
      this.logger.error(`Failed to sign transaction with wallet ${walletId}:`, error);
      throw new Error('Transaction signing failed');
    }
  }

  /**
   * Rotates a wallet's private key (creates new keypair, updates encrypted storage)
   */
  async rotateWalletKey(walletId: string): Promise<WalletCreationResult> {
    const existingWallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!existingWallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    // Generate new keypair
    const newKeyPair = this.generateStellarKeyPair();
    
    // Encrypt the new private key
    const newEncryptedSecret = this.encryptionService.encryptAndSerialize(newKeyPair.privateKey);

    try {
      // Update existing wallet with new key
      const updatedWallet = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          publicKey: newKeyPair.publicKey,
          encryptedSecret: newEncryptedSecret,
          secretVersion: existingWallet.secretVersion + 1,
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Successfully rotated key for wallet ${walletId}`);

      return {
        wallet: this.mapPrismaWalletToDomain(updatedWallet),
        privateKey: newKeyPair.privateKey,
      };
    } catch (error) {
      this.logger.error(`Failed to rotate wallet ${walletId}:`, error);
      throw new Error('Wallet key rotation failed');
    }
  }

  /**
   * Updates wallet status (for suspension, disabling, etc.)
   */
  async updateWalletStatus(walletId: string, status: WalletStatus, reason?: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    try {
      const updatedWallet = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          status,
          statusReason: reason,
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Updated wallet ${walletId} status to ${status}`);
      return this.mapPrismaWalletToDomain(updatedWallet);
    } catch (error) {
      this.logger.error(`Failed to update wallet ${walletId} status:`, error);
      throw new Error('Wallet status update failed');
    }
  }

  /**
   * Generates a Stellar keypair (simplified for MVP)
   * In production, use stellar-sdk's Keypair.random()
   */
  private generateStellarKeyPair(): { publicKey: string; privateKey: string } {
    // This is a simplified example - use stellar-sdk in production
    const keyPair = crypto.generateKeyPairSync('ed25519');
    return {
      publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
      privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
    };
  }

  /**
   * Signs data with a private key (simplified example)
   * In production, use stellar-sdk's signing functionality
   */
  private signWithPrivateKey(privateKey: string, data: string): string {
    // This is a simplified example - use stellar-sdk in production
    const key = crypto.createPrivateKey({
      key: Buffer.from(privateKey, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    
    const signature = crypto.sign('sha256', Buffer.from(data), key);
    return signature.toString('hex');
  }

  /**
   * Maps Prisma wallet entity to domain model
   */
  private mapPrismaWalletToDomain(prismaWallet: any): Wallet {
    return {
      id: prismaWallet.id,
      userId: prismaWallet.userId,
      publicKey: prismaWallet.publicKey,
      encryptedSecret: prismaWallet.encryptedSecret,
      encryptionVersion: prismaWallet.encryptionVersion,
      secretVersion: prismaWallet.secretVersion,
      network: prismaWallet.network as WalletNetwork,
      status: prismaWallet.status as WalletStatus,
      statusReason: prismaWallet.statusReason,
      statusChangedAt: prismaWallet.statusChangedAt,
      rotatedFromId: prismaWallet.rotatedFromId,
      createdAt: prismaWallet.createdAt,
      updatedAt: prismaWallet.updatedAt,
    };
  }

  // Legacy methods for compatibility
  create(createWalletDto: any) {
    return this.createWallet(createWalletDto);
  }

  findAll() {
    return this.prisma.wallet.findMany();
  }

  findOne(id: number) {
    return this.findWalletById(id.toString());
  }

  update(id: number, updateWalletDto: any) {
    return this.updateWalletStatus(id.toString(), updateWalletDto.status);
  }

  remove(id: number) {
    return this.prisma.wallet.delete({ where: { id: id.toString() } });
  }
}
