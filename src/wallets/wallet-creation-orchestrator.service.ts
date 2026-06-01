import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import { WalletNetwork, WalletStatus, Wallet } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import * as crypto from 'crypto';

export type OrchestrationPhase =
  | 'user-resolution'
  | 'idempotency-check'
  | 'key-generation'
  | 'key-encryption'
  | 'wallet-persist'
  | 'wallet-activation'
  | 'idempotency-store';

export class WalletOrchestrationError extends Error {
  constructor(
    message: string,
    public readonly phase: OrchestrationPhase,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WalletOrchestrationError';
  }
}

export interface User {
  id: string;
  authId: string;
  email?: string;
  displayName?: string;
  status: string;
  authProvider: string;
  lastLoginAt?: Date;
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
    private idempotentUserService: IdempotentUserService,
    prismaClient?: PrismaClient,
  ) {
    this.prisma = prismaClient ?? new PrismaClient(undefined);
  }

  async onModuleInit() {
    // Validate encryption configuration on startup
    if (!this.encryptionService.validateConfiguration()) {
      throw new Error(
        'Wallet creation orchestrator encryption configuration is invalid',
      );
    }
    this.logger.log(
      'Wallet creation orchestrator initialized with encryption validation passed',
    );
  }

  /**
   * Orchestrates the complete wallet creation flow with atomic operations and idempotency.
   *
   * Rollback strategy:
   * - Wallets are first written in PROVISIONING status inside a DB transaction.
   * - On success the same transaction updates the wallet to ACTIVE.
   * - If any step throws, Prisma rolls back the entire transaction automatically,
   *   leaving no partial wallet record in the database.
   * - Stale PROVISIONING wallets (from crashed processes) can be cleaned up via
   *   `cleanupStaleProvisioningWallets`.
   */
  async createWallet(
    request: CreateWalletOrchestratorRequest,
  ): Promise<WalletOrchestrationResult> {
    const startTime = Date.now();
    this.logger.log(
      `Starting wallet creation orchestration for user ${request.userId} on ${request.network}`,
    );

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // --- Phase: user-resolution ---
        const context = await this.buildOrchestrationContext(request, tx);

        // --- Phase: idempotency-check ---
        if (request.idempotencyKey) {
          const existingResult = await this.checkIdempotency(
            request.idempotencyKey,
            tx,
          );
          if (existingResult) {
            this.logger.log(
              `Returning cached result for idempotency key: ${request.idempotencyKey}`,
            );
            return existingResult;
          }
        }

        // Enforce one wallet per user per network
        if (context.existingWallet) {
          this.logger.log(
            `User ${request.userId} already has wallet on ${request.network}`,
          );
          return {
            wallet: context.existingWallet,
            privateKey: '',
            isNewWallet: false,
            idempotencyKey: request.idempotencyKey,
          };
        }

        // --- Phases: key-generation → key-encryption → wallet-persist → wallet-activation ---
        const newWallet = await this.createNewWallet(context, tx);

        const txResult: WalletOrchestrationResult = {
          wallet: newWallet.wallet,
          privateKey: newWallet.privateKey,
          isNewWallet: true,
          idempotencyKey: request.idempotencyKey,
        };

        // --- Phase: idempotency-store ---
        if (request.idempotencyKey) {
          await this.storeIdempotencyRecord(
            request.idempotencyKey,
            txResult,
            tx,
          );
        }

        return txResult;
      });

      const duration = Date.now() - startTime;
      this.logger.log(
        `Wallet creation orchestration completed in ${duration}ms for user ${request.userId}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Wallet creation orchestration failed for user ${request.userId}:`,
        error,
      );

      if (error instanceof ConflictException || error instanceof NotFoundException) {
        throw error;
      }

      if (error instanceof WalletOrchestrationError) {
        throw error;
      }

      throw new WalletOrchestrationError(
        'Wallet creation orchestration failed',
        'wallet-persist',
        error,
      );
    }
  }

  /**
   * Removes stale PROVISIONING wallets older than `olderThanMs` milliseconds.
   * Call this from a scheduled job or on startup to recover from crashed orchestrations.
   */
  async cleanupStaleProvisioningWallets(olderThanMs = 5 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const { count } = await this.prisma.wallet.deleteMany({
      where: {
        status: WalletStatus.PROVISIONING,
        createdAt: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.warn(
        `Cleaned up ${count} stale PROVISIONING wallet(s) older than ${olderThanMs}ms`,
      );
    }
    return count;
  }

  /**
   * Builds the orchestration context with user lookup and existing wallet check
   */
  private async buildOrchestrationContext(
    request: CreateWalletOrchestratorRequest,
    tx: any, // Use any for transaction client to avoid type issues
  ): Promise<OrchestrationContext> {
    // Resolve internal user
    const user = await this.resolveUser(request.userId, tx);
    if (!user) {
      throw new NotFoundException(`User with ID ${request.userId} not found`);
    }

    // Check for existing wallet
    const existingWallet = await this.findExistingWallet(
      request.userId,
      request.network,
      tx,
    );

    return {
      user,
      request,
      existingWallet,
    };
  }

  /**
   * Resolves user from database using the idempotent user service
   */
  private async resolveUser(userId: string, tx: any): Promise<User | null> {
    // Use the idempotent user service to find user by ID
    const user = await this.idempotentUserService.findUserById(userId);

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return user;
  }

  /**
   * Checks if user already has a wallet on the specified network
   */
  private async findExistingWallet(
    userId: string,
    network: WalletNetwork,
    tx: any,
  ): Promise<Wallet | undefined> {
    const existingWallet = await tx.wallet.findFirst({
      where: { userId, network },
    });

    return existingWallet
      ? this.mapPrismaWalletToDomain(existingWallet)
      : undefined;
  }

  /**
   * Creates a new wallet using a two-phase write inside the active transaction:
   *   1. Insert with status PROVISIONING (rollback-safe sentinel).
   *   2. Activate to ACTIVE in the same transaction.
   *
   * If any step throws, Prisma rolls back both writes automatically.
   */
  private async createNewWallet(
    context: OrchestrationContext,
    tx: any,
  ): Promise<{ wallet: Wallet; privateKey: string }> {
    const { request } = context;

    // Phase: key-generation
    let keyPair: { publicKey: string; privateKey: string };
    try {
      keyPair = this.generateStellarKeyPair();
    } catch (error) {
      throw new WalletOrchestrationError(
        'Key generation failed',
        'key-generation',
        error,
      );
    }

    // Phase: key-encryption
    let encryptedSecret: string;
    try {
      encryptedSecret = this.encryptionService.encryptAndSerialize(
        keyPair.privateKey,
      );
    } catch (error) {
      throw new WalletOrchestrationError(
        'Key encryption failed',
        'key-encryption',
        error,
      );
    }

    // Phase: wallet-persist (PROVISIONING)
    let provisioningWallet: any;
    try {
      provisioningWallet = await tx.wallet.create({
        data: {
          userId: request.userId,
          publicKey: keyPair.publicKey,
          encryptedSecret,
          network: request.network,
          status: WalletStatus.PROVISIONING,
          encryptionVersion: 1,
          secretVersion: 1,
        },
      });
    } catch (error) {
      throw new WalletOrchestrationError(
        'Wallet persist failed',
        'wallet-persist',
        error,
      );
    }

    // Phase: wallet-activation (ACTIVE) — still inside the same transaction
    let activatedWallet: any;
    try {
      activatedWallet = await tx.wallet.update({
        where: { id: provisioningWallet.id },
        data: {
          status: WalletStatus.ACTIVE,
          statusChangedAt: new Date(),
        },
      });
    } catch (error) {
      throw new WalletOrchestrationError(
        'Wallet activation failed',
        'wallet-activation',
        error,
      );
    }

    this.logger.log(
      `Created and activated wallet for user ${request.userId} on ${request.network}`,
    );

    return {
      wallet: this.mapPrismaWalletToDomain(activatedWallet),
      privateKey: keyPair.privateKey,
    };
  }

  /**
   * Checks idempotency for duplicate requests
   */
  private async checkIdempotency(
    idempotencyKey: string,
    tx: any, // Use any for transaction client to avoid type issues
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
    tx: any, // Use any for transaction client to avoid type issues
  ): Promise<void> {
    // In a real implementation, this would store in an idempotency table
    // For now, we'll skip this as we don't have the table structure
    this.logger.log(
      `Idempotency record would be stored for key: ${idempotencyKey}`,
    );
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
  async getWalletByUser(
    userId: string,
    network: WalletNetwork,
  ): Promise<Wallet | null> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });

    return wallet ? this.mapPrismaWalletToDomain(wallet) : null;
  }

  /**
   * Validates user can create wallet on specified network
   */
  async validateUserCanCreateWallet(
    userId: string,
    network: WalletNetwork,
  ): Promise<boolean> {
    const existingWallet = await this.getWalletByUser(userId, network);
    return existingWallet === null;
  }
}
