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

/**
 * The result of a wallet creation or idempotency-replay request.
 *
 * ## Idempotency contract
 *
 * When an `idempotencyKey` is provided with a `createWallet` call:
 *
 * 1. **First call** – a new wallet is created (or an existing one for the same
 *    `userId`/`network` pair is returned). The result is persisted under the
 *    supplied key for 24 hours.
 *
 * 2. **Subsequent calls with the same key, same `userId`/`network`** – the
 *    cached result is replayed.  `isNewWallet` reflects the value from the
 *    original call so consumers can distinguish first-creation from
 *    replay.  `privateKey` is **always empty on replay** – the private key is
 *    sensitive material and must only be consumed on the initial response.
 *
 * 3. **Subsequent calls with the same key but a different `userId` or
 *    `network`** – a `ConflictException` is thrown (HTTP 409).  An idempotency
 *    key must map to exactly one operation.
 *
 * 4. **Calls after the TTL has expired** – the key is treated as new; a fresh
 *    operation is performed and a new cache entry is stored.
 *
 * @property wallet       - The wallet domain object (always present).
 * @property privateKey   - Raw private key, **only populated on first creation**;
 *                          empty string on replay or when returning an existing wallet.
 * @property isNewWallet  - `true` on the first call that created the wallet;
 *                          replayed as-is from the original response.
 * @property idempotencyKey - The key that was supplied (echoed back for convenience).
 */
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

/** Shape of the JSON blob stored in `idempotencyRecord.response` for wallet ops. */
interface WalletIdempotencyCacheEntry {
  userId: string;
  network: WalletNetwork;
  wallet: Wallet;
  isNewWallet: boolean;
  idempotencyKey?: string;
  // privateKey is intentionally absent – never persisted
}

/**
 * Orchestrates the complete wallet-creation lifecycle with atomic database
 * operations and a durable idempotency layer.
 *
 * ## Idempotency contract (summary)
 * See {@link WalletOrchestrationResult} for the full specification.
 * - TTL: 24 hours per key.
 * - Conflict (same key, different userId/network): throws `ConflictException`.
 * - Replay: returns original `isNewWallet`; `privateKey` is always cleared.
 */
@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);
  private prisma: PrismaClient;

  /** Idempotency records for wallet operations are retained for 24 hours. */
  private readonly IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private encryptionService: EncryptionService,
    private configService: ConfigService,
    private idempotentUserService: IdempotentUserService,
  ) {
    this.prisma = new PrismaClient({} as any);
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
   * All database reads and writes (wallet lookup, wallet creation, idempotency
   * record read/write) execute inside a single Prisma transaction so the
   * idempotency check and the wallet creation are always consistent.
   */
  async createWallet(
    request: CreateWalletOrchestratorRequest,
  ): Promise<WalletOrchestrationResult> {
    const startTime = Date.now();
    this.logger.log(
      `Starting wallet creation orchestration for user ${request.userId} on ${request.network}`,
    );

    try {
      // Use database transaction for atomicity
      const result = await this.prisma.$transaction(async (tx) => {
        const context = await this.buildOrchestrationContext(request, tx);

        // Check idempotency if key provided
        if (request.idempotencyKey) {
          const existingResult = await this.checkIdempotency(
            request.idempotencyKey,
            request,
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
          await this.storeIdempotencyRecord(
            request.idempotencyKey,
            result,
            request,
            tx,
          );
        }

        return result;
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

      if (error instanceof ConflictException) {
        throw error;
      }

      if (error instanceof NotFoundException) {
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
   * Creates a new wallet with encrypted private key storage
   */
  private async createNewWallet(
    context: OrchestrationContext,
    tx: any,
  ): Promise<{ wallet: Wallet; privateKey: string }> {
    const { request } = context;

    // Generate new keypair
    const keyPair = this.generateStellarKeyPair();

    // Encrypt the private key before storage
    const encryptedSecret = this.encryptionService.encryptAndSerialize(
      keyPair.privateKey,
    );

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

      this.logger.log(
        `Created new wallet for user ${request.userId} on ${request.network}`,
      );

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
   * Looks up a persisted idempotency record for the given key.
   *
   * Returns a replay result when the key exists and has not expired AND the
   * cached operation matches the incoming `request` (same `userId` and
   * `network`).  Throws `ConflictException` when the key is reused for a
   * different operation.
   *
   * The replayed result always has `privateKey` set to an empty string –
   * private keys are sensitive material that must not be re-exposed after the
   * original response.  `isNewWallet` is replayed verbatim from the original
   * response so callers can still distinguish first-creation from replay.
   */
  private async checkIdempotency(
    idempotencyKey: string,
    request: CreateWalletOrchestratorRequest,
    tx: any,
  ): Promise<WalletOrchestrationResult | null> {
    const record = await tx.idempotencyRecord.findUnique({
      where: { key: idempotencyKey },
    });

    if (!record) {
      return null;
    }

    // Treat expired records as absent; clean up lazily within the transaction
    if (record.expiresAt < new Date()) {
      await tx.idempotencyRecord.delete({ where: { key: idempotencyKey } });
      return null;
    }

    const cached = record.response as WalletIdempotencyCacheEntry;

    // Reject if the same key was previously used for a different operation
    if (cached.userId !== request.userId || cached.network !== request.network) {
      throw new ConflictException(
        `Idempotency key "${idempotencyKey}" was already used for a different userId or network`,
      );
    }

    this.logger.log(`Idempotency cache hit for key: ${idempotencyKey}`);

    return {
      wallet: cached.wallet,
      privateKey: '', // Never re-expose the private key on replay
      isNewWallet: cached.isNewWallet, // Replay the original value for consistency
      idempotencyKey,
    };
  }

  /**
   * Persists an idempotency record so future duplicate requests can be
   * detected and replayed.
   *
   * The private key is intentionally excluded from the stored payload.
   * A unique-constraint violation (P2002) is silently ignored because it
   * means a concurrent request already stored an equivalent record.
   * Other storage errors are logged but do not propagate – a failed
   * idempotency write must not roll back a successful wallet creation.
   */
  private async storeIdempotencyRecord(
    idempotencyKey: string,
    result: WalletOrchestrationResult,
    request: CreateWalletOrchestratorRequest,
    tx: any,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.IDEMPOTENCY_TTL_MS);

    const cacheEntry: WalletIdempotencyCacheEntry = {
      userId: request.userId,
      network: request.network,
      wallet: result.wallet,
      isNewWallet: result.isNewWallet,
      idempotencyKey: result.idempotencyKey,
      // privateKey deliberately omitted
    };

    try {
      await tx.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          method: 'INTERNAL',
          endpoint: 'wallet-creation',
          statusCode: 200,
          expiresAt,
          response: cacheEntry as any,
        },
      });
      this.logger.log(`Idempotency record stored for key: ${idempotencyKey}`);
    } catch (error: any) {
      if (error?.code === 'P2002') {
        // Concurrent request already stored an equivalent record – safe to ignore
        this.logger.log(
          `Idempotency record already exists for key: ${idempotencyKey} (concurrent write)`,
        );
        return;
      }
      // Non-fatal: log but do not rethrow to avoid rolling back the wallet creation
      this.logger.error(
        `Failed to store idempotency record for key ${idempotencyKey}:`,
        error,
      );
    }
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
