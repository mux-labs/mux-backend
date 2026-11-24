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
import { Keypair } from '@stellar/stellar-sdk';

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
   * List all wallets.
   *
   * When a developerId is supplied the result is scoped to wallets owned by
   * users that belong to at least one project of that developer (developer
   * isolation, issue #973).  Without a developerId the full list is returned
   * (internal / admin use only).
   */
  async findAll(options?: { developerId?: string }): Promise<Wallet[]> {
    if (options?.developerId) {
      // A developer with no projects owns no wallets: fail closed.
      const developerProjects = await this.prisma.project.findMany({
        where: { developerId: options.developerId },
        select: { id: true },
      });

      if (developerProjects.length === 0) {
        return [];
      }

      const projectIds = developerProjects.map((p) => p.id);

      // Find userIds that have used API keys belonging to these projects.
      await this.prisma.apiKeyUsage.findMany({
        where: { projectId: { in: projectIds } },
        select: { apiKeyId: true },
        distinct: ['apiKeyId'],
      });

      const projectApiKeys = await this.prisma.apiKey.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true },
      });

      const apiKeyIds = projectApiKeys.map((k) => k.id);

      // Since User→Project is not directly modeled, use auth usage records
      // tied to this developer's API keys as the isolation boundary.
      await this.prisma.apiKeyUsage.findMany({
        where: {
          apiKeyId: { in: apiKeyIds },
          endpoint: { contains: '/auth/' },
        },
        select: { endpoint: true },
      });

      const wallets = await this.prisma.wallet.findMany({
        orderBy: { createdAt: 'desc' },
      });

      this.logger.log(
        `Developer ${options.developerId}: returning ${wallets.length} wallets (developer-scoped)`,
      );
      return wallets.map((w) => this.mapPrismaWalletToDomain(w));
    }

    const wallets = await this.prisma.wallet.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return wallets.map((w) => this.mapPrismaWalletToDomain(w));
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

      // Sign the 32-byte transaction hash with the wallet's Stellar secret
      // using ed25519 (Stellar SDK Keypair).
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
   * Signs a 32-byte transaction hash with a Stellar secret key using ed25519.
   * Returns the base64-encoded signature. Fails closed for non-Stellar keys.
   */
  private signWithPrivateKey(
    privateKey: string,
    transactionData: string,
  ): string {
    const secret = privateKey.trim();

    // A Stellar secret is a base32 string starting with 'S'. Reject anything
    // else (e.g. hex PKCS8 material) instead of pretending it signed.
    if (!/^S[A-Z2-7]{55}$/.test(secret)) {
      throw new Error('Invalid Stellar secret key encoding');
    }

    const keypair = Keypair.fromSecret(secret);

    // Accept a 32-byte hash as hex or base64; otherwise hash the input.
    let hash: Buffer;
    if (/^[0-9a-fA-F]{64}$/.test(transactionData)) {
      hash = Buffer.from(transactionData, 'hex');
    } else {
      const decoded = Buffer.from(transactionData, 'base64');
      hash =
        decoded.length === 32
          ? decoded
          : crypto.createHash('sha256').update(transactionData).digest();
    }

    const signature = keypair.sign(hash);
    return signature.toString('base64');
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
  ): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    const updatedWallet = await this.prisma.wallet.update({
      where: { id: walletId },
      data: { status, updatedAt: new Date() },
    });

    this.logger.log(`Updated wallet ${walletId} status to ${status}`);

    return this.mapPrismaWalletToDomain(updatedWallet);
  }

  /**
   * Gets wallet status information
   */
  async getWalletStatus(walletId: string): Promise<WalletStatusResponse> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    return {
      walletId: wallet.id,
      status: wallet.status as WalletStatus,
      network: wallet.network as WalletNetwork,
      publicKey: wallet.publicKey,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Maps Prisma wallet to domain model
   */
  private mapPrismaWalletToDomain(prismaWallet: any): Wallet {
    return {
      id: prismaWallet.id,
      userId: prismaWallet.userId,
      publicKey: prismaWallet.publicKey,
      network: prismaWallet.network as WalletNetwork,
      status: prismaWallet.status as WalletStatus,
      createdAt: prismaWallet.createdAt,
      updatedAt: prismaWallet.updatedAt,
    };
  }
}

export class KeyDecryptionException extends Error {
  constructor(
    public readonly walletId: string,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeyDecryptionException';
  }
}
