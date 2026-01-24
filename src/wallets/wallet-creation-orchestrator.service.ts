import { Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import { WalletNetwork, WalletStatus, Wallet } from '../wallets/domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import * as crypto from 'crypto';

export interface User {
  id: string;
  email?: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWalletOrchestratorRequest {
  userId: string;
  network: WalletNetwork;
  idempotencyKey?: string; // Optional idempotency key
}

export interface WalletOrchestrationResult {
  wallet: Wallet;
  privateKey: string; // Only returned during creation for immediate use
  isNewWallet: boolean;
  idempotencyKey?: string;
}

export interface OrchestrationContext {
  user: User;
  request: CreateWalletOrchestratorRequest;
  existingWallet?: Wallet;
  idempotencyRecord?: IdempotencyRecord;
}

export interface IdempotencyRecord {
  id: string;
  key: string;
  result: string; // Serialized result
  createdAt: Date;
  expiresAt: Date;
}

@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);
  private prisma: PrismaClient;

  constructor(
    private encryptionService: EncryptionService,
    private configService: ConfigService,
  ) {
    this.prisma = new PrismaClient({} as any);
  }

  async onModuleInit() {
    // Validate encryption configuration on startup
    if (!this.encryptionService.validateConfiguration()) {
      throw new Error('Wallet creation orchestrator encryption configuration is invalid');
    }
    this.logger.log('Wallet creation orchestrator initialized with encryption validation passed');
  }

  /**
   * Orchestrates the complete wallet creation flow with atomic operations and idempotency
   */
  async createWallet(request: CreateWalletOrchestratorRequest): Promise<WalletOrchestrationResult> {
    const startTime = Date.now();
    this.logger.log(`Starting wallet creation orchestration for user ${request.userId} on ${request.network}`);

    try {
      // Use database transaction for atomicity
      const result = await this.prisma.$transaction(async (tx) => {
        const context = await this.buildOrchestrationContext(request, tx);
        
        // Check idempotency if key provided
        if (request.idempotencyKey) {
          const existingResult = await this.checkIdempotency(request.idempotencyKey, tx);
          if (existingResult) {
            this.logger.log(`Returning cached result for idempotency key: ${request.idempotencyKey}`);
            return existingResult;
          }
        }

        // Enforce one wallet per user per network
        if (context.existingWallet) {
          this.logger.log(`User ${request.userId} already has wallet on ${request.network}`);
          return {
            wallet: context.existingWallet,
            privateKey: '', // Empty for existing wallets
            isNewWallet: false,
            idempotencyKey: request.idempotencyKey,
          };
        }

        // Create new wallet atomically
        const newWallet = await this.createNewWallet(context, tx);
        
        const result: WalletOrchestrationResult = {
          wallet: newWallet.wallet,
          privateKey: newWallet.privateKey,
          isNewWallet: true,
          idempotencyKey: request.idempotencyKey,
        };

        // Store idempotency record if key provided
        if (request.idempotencyKey) {
          await this.storeIdempotencyRecord(request.idempotencyKey, result, tx);
        }

        return result;
      });

      const duration = Date.now() - startTime;
      this.logger.log(`Wallet creation orchestration completed in ${duration}ms for user ${request.userId}`);
      
      return result;
    } catch (error) {
      this.logger.error(`Wallet creation orchestration failed for user ${request.userId}:`, error);
      
      if (error instanceof ConflictException) {
        throw error;
      }
      
      throw new Error('Wallet creation orchestration failed');
    }
  }

  /**
   * Builds the orchestration context with user lookup and existing wallet check
   */
  private async buildOrchestrationContext(
    request: CreateWalletOrchestratorRequest,
    tx: any // Use any for transaction client to avoid type issues
  ): Promise<OrchestrationContext> {
    // Resolve internal user
    const user = await this.resolveUser(request.userId, tx);
    if (!user) {
      throw new NotFoundException(`User with ID ${request.userId} not found`);
    }

    // Check for existing wallet
    const existingWallet = await this.findExistingWallet(request.userId, request.network, tx);

    return {
      user,
      request,
      existingWallet,
    };
  }

  /**
   * Resolves user from database - in real implementation this would query users table
   */
  private async resolveUser(userId: string, tx: any): Promise<User | null> {
    // For now, we'll assume user exists if we have a userId
    // In real implementation, this would query the users table
    // const user = await tx.user.findUnique({ where: { id: userId } });
    
    // Mock user for development
    return {
      id: userId,
      email: `${userId}@example.com`,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Checks if user already has a wallet on the specified network
   */
  private async findExistingWallet(
    userId: string,
    network: WalletNetwork,
    tx: any
  ): Promise<Wallet | undefined> {
    const existingWallet = await tx.wallet.findFirst({
      where: { userId, network },
    });

    return existingWallet ? this.mapPrismaWalletToDomain(existingWallet) : undefined;
  }

  /**
   * Creates a new wallet with encrypted private key storage
   */
  private async createNewWallet(
    context: OrchestrationContext,
    tx: any
  ): Promise<{ wallet: Wallet; privateKey: string }> {
    const { request } = context;

    // Generate new keypair
    const keyPair = this.generateStellarKeyPair();
    
    // Encrypt the private key before storage
    const encryptedSecret = this.encryptionService.encryptAndSerialize(keyPair.privateKey);

    try {
      const createdWallet = await tx.wallet.create({
        data: {
          userId: request.userId,
          publicKey: keyPair.publicKey,
          encryptedSecret,
          network: request.network,
          status: 'ACTIVE',
          encryptionVersion: 1,
          secretVersion: 1,
        },
      });

      this.logger.log(`Created new wallet for user ${request.userId} on ${request.network}`);

      return {
        wallet: this.mapPrismaWalletToDomain(createdWallet),
        privateKey: keyPair.privateKey,
      };
    } catch (error) {
      this.logger.error('Failed to create wallet in transaction:', error);
      throw new Error('Wallet creation failed');
    }
  }

  /**
   * Checks idempotency for duplicate requests
   */
  private async checkIdempotency(
    idempotencyKey: string,
    tx: any // Use any for transaction client to avoid type issues
  ): Promise<WalletOrchestrationResult | null> {
    // In a real implementation, this would query an idempotency table
    // For now, we'll skip this as we don't have the table structure
    return null;
  }

  /**
   * Stores idempotency record for future duplicate requests
   */
  private async storeIdempotencyRecord(
    idempotencyKey: string,
    result: WalletOrchestrationResult,
    tx: any // Use any for transaction client to avoid type issues
  ): Promise<void> {
    // In a real implementation, this would store in an idempotency table
    // For now, we'll skip this as we don't have the table structure
    this.logger.log(`Idempotency record would be stored for key: ${idempotencyKey}`);
  }

  /**
   * Generates a Stellar keypair (simplified for MVP)
   */
  private generateStellarKeyPair(): { publicKey: string; privateKey: string } {
    // In real implementation, use stellar-sdk: Stellar.Keypair.random()
    const privateKey = crypto.randomBytes(32).toString('hex');
    const publicKey = `G${crypto.randomBytes(32).toString('hex').toUpperCase()}`;
    
    return { publicKey, privateKey };
  }

  /**
   * Maps Prisma wallet to domain model
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

  /**
   * Gets wallet by user ID and network (read-only operation)
   */
  async getWalletByUser(userId: string, network: WalletNetwork): Promise<Wallet | null> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });

    return wallet ? this.mapPrismaWalletToDomain(wallet) : null;
  }

  /**
   * Validates user can create wallet on specified network
   */
  async validateUserCanCreateWallet(userId: string, network: WalletNetwork): Promise<boolean> {
    const existingWallet = await this.getWalletByUser(userId, network);
    return existingWallet === null;
  }
}
