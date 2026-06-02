import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import {
  WalletNetwork,
  WalletStatus,
  Wallet,
  WalletStatusResponse,
} from './domain/wallet.model';
import {
  EncryptionService,
  DecryptionError,
} from '../encryption/encryption.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';
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
    private keyManagementService: KeyManagementService,
  ) {
    this.prisma = new PrismaClient(undefined);
  }

  async onModuleInit() {
    // Validate encryption configuration on startup
    if (!this.encryptionService.validateConfiguration()) {
      throw new Error('Wallet encryption service configuration is invalid');
    }
    this.logger.log(
      'Wallet service initialized with encryption validation passed',
    );
  }

  /**
   * Creates a new wallet with encrypted private key storage
   */
  async createWallet(
    request: CreateWalletRequest,
  ): Promise<WalletCreationResult> {
    const { userId, network } = request;

    // Check if user already has a wallet on this network
    const existingWallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });

    if (existingWallet) {
      throw new ConflictException(`User already has a wallet on ${network}`);
    }

    // Generate new keypair using centralized key management service
    const encryptedKeyMaterial = await this.keyManagementService.generateKey({
      keyType: KeyType.STELLAR_ED25519,
      metadata: { userId, network },
    });

    try {
      const createdWallet = await this.prisma.wallet.create({
        data: {
          userId,
          publicKey: encryptedKeyMaterial.publicKey,
          encryptedSecret: encryptedKeyMaterial.encryptedData,
          network,
          status: 'ACTIVE',
          encryptionVersion: encryptedKeyMaterial.encryptionVersion,
          secretVersion: 1,
          keyVersion: 1,
        },
      });

      this.logger.log(`Created new wallet for user ${userId} on ${network}`);

      // Temporarily decrypt for return (only during creation)
      const privateKey = this.encryptionService.deserializeAndDecrypt(
        encryptedKeyMaterial.encryptedData,
      );

      return {
        wallet: this.mapPrismaWalletToDomain(createdWallet),
        privateKey, // Return only for immediate use
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
  async findWalletByUser(
    userId: string,
    network: WalletNetwork,
  ): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });

    if (!wallet) {
      throw new NotFoundException(
        `Wallet for user ${userId} on ${network} not found`,
      );
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
      const privateKey = this.encryptionService.deserializeAndDecrypt(
        wallet.encryptedSecret,
      );
      this.logger.log(
        `Successfully decrypted private key for wallet ${walletId}`,
      );
      return privateKey;
    } catch (error) {
      if (error instanceof DecryptionError) {
        this.logger.error(`Decryption failed for wallet ${walletId}:`, {
          code: error.code,
        });
        throw new KeyDecryptionException(
          walletId,
          error.code,
          `Wallet key decryption failed — the key material may be corrupted or the encryption key may have changed`,
        );
      }
      this.logger.error(
        `Unexpected error decrypting wallet ${walletId}:`,
        error,
      );
      throw new Error('Failed to access wallet private key');
    }
  }

  /**
   * Signs a transaction using the wallet's private key
   */
  async signTransaction(
    walletId: string,
    transactionData: string,
  ): Promise<SigningResult> {
    try {
      const privateKey = await this.getDecryptedPrivateKey(walletId);

      // For Stellar, we would use the SDK to sign
      // This is a simplified example - in production you'd use stellar-sdk
      const signature = this.signWithPrivateKey(privateKey, transactionData);

      this.logger.log(
        `Successfully signed transaction with wallet ${walletId}`,
      );

      return {
        signature,
        // transactionHash would be calculated based on the signed transaction
      };
    } catch (error) {
      this.logger.error(
        `Failed to sign transaction with wallet ${walletId}:`,
        error,
      );
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

    // Generate new keypair using centralized key management service
    const encryptedKeyMaterial = await this.keyManagementService.generateKey({
      keyType: KeyType.STELLAR_ED25519,
      metadata: { walletId, operation: 'rotation' },
    });

    try {
      // Update existing wallet with new key
      const updatedWallet = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          publicKey: encryptedKeyMaterial.publicKey,
          encryptedSecret: encryptedKeyMaterial.encryptedData,
          secretVersion: existingWallet.secretVersion + 1,
          encryptionVersion: encryptedKeyMaterial.encryptionVersion,
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Successfully rotated key for wallet ${walletId}`);

      // Temporarily decrypt for return
      const privateKey = this.encryptionService.deserializeAndDecrypt(
        encryptedKeyMaterial.encryptedData,
      );

      return {
        wallet: this.mapPrismaWalletToDomain(updatedWallet),
        privateKey,
      };
    } catch (error) {
      this.logger.error(`Failed to rotate wallet ${walletId}:`, error);
      throw new Error('Wallet key rotation failed');
    }
  }

  /**
   * Updates wallet status (for suspension, disabling, etc.)
   */
  async updateWalletStatus(
    walletId: string,
    status: WalletStatus,
    reason?: string,
  ): Promise<Wallet> {
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
      keyVersion: prismaWallet.keyVersion ?? 1,
      network: prismaWallet.network as WalletNetwork,
      status: prismaWallet.status as WalletStatus,
      statusReason: prismaWallet.statusReason,
      statusChangedAt: prismaWallet.statusChangedAt,
      rotatedFromId: prismaWallet.rotatedFromId,
      successorId: prismaWallet.successorId,
      createdAt: prismaWallet.createdAt,
      updatedAt: prismaWallet.updatedAt,
    };
  }

  // ──────────────────────────────────────────────
  // #185: Wallet Status Endpoint
  // ──────────────────────────────────────────────

  /**
   * Returns the current status of a wallet.
   */
  async getWalletStatus(walletId: string): Promise<WalletStatusResponse> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    return {
      id: wallet.id,
      status: wallet.status as WalletStatus,
      statusReason: wallet.statusReason,
      statusChangedAt: wallet.statusChangedAt,
      network: wallet.network as WalletNetwork,
      publicKey: wallet.publicKey,
      userId: wallet.userId,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Transitions a PROVISIONING wallet to ACTIVE.
   */
  async activateWallet(
    walletId: string,
    statusReason?: string,
  ): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    if (wallet.status !== 'PROVISIONING') {
      throw new Error(
        `Cannot activate wallet in status: ${wallet.status}. Only PROVISIONING wallets can be activated.`,
      );
    }

    try {
      const updatedWallet = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          status: 'ACTIVE',
          statusReason: statusReason ?? 'Wallet provisioned and activated',
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Activated wallet ${walletId} (PROVISIONING -> ACTIVE)`);
      return this.mapPrismaWalletToDomain(updatedWallet);
    } catch (error) {
      this.logger.error(`Failed to activate wallet ${walletId}:`, error);
      throw new Error('Wallet activation failed');
    }
  }

  // ──────────────────────────────────────────────
  // #189: Wallet List by UserId
  // ──────────────────────────────────────────────

  /**
   * Returns all wallets for a given userId.
   */
  async findWalletsByUserId(userId: string): Promise<Wallet[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return wallets.map((w) => this.mapPrismaWalletToDomain(w));
  }

  // Legacy methods for compatibility
  create(createWalletDto: any) {
    return this.createWallet(createWalletDto);
  }

  findAll() {
    return this.prisma.wallet.findMany();
  }

  findOne(id: string) {
    return this.findWalletById(id);
  }

  update(id: string, updateWalletDto: any) {
    return this.updateWalletStatus(id, updateWalletDto.status);
  }

  remove(id: string) {
    return this.prisma.wallet.delete({ where: { id } });
  }
}
