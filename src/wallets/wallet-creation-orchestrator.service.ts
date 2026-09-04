import {
  Injectable,
  ConflictException,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaClient } from '../generated/prisma/client';
import {
  WalletNetwork,
  WalletStatus,
  Wallet,
  WalletStatusResponse,
} from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { SafeLogger } from '../common/safe-logger';
import { CacheService } from '../common/cache/cache.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { requestIdAwareFetch } from '../common/http/request-id-fetch';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { WalletRetryService } from './wallet-retry.service';
import { WalletApiMetricsService } from './wallet-api-metrics.service';
import { WalletOrchestratorMetricsService } from './wallet-orchestrator-metrics.service';

export type OrchestrationPhase =
  | 'user-resolution'
  | 'idempotency-check'
  | 'key-generation'
  | 'key-encryption'
  | 'wallet-persist'
  | 'wallet-activation'
  | 'idempotency-store';

export type OrchestrationOutcome =
  | 'created'
  | 'existing'
  | 'idempotent'
  | 'failed';

export interface OrchestratorMetrics {
  userId: string;
  network: WalletNetwork;
  outcome: OrchestrationOutcome;
  durationMs: number;
  /** The incoming request ID when available. */
  requestId?: string;
  /** Phase timings in milliseconds, only present for new wallet creation. */
  phases?: Partial<Record<OrchestrationPhase, number>>;
  /** Set when outcome is 'failed'. */
  failedPhase?: OrchestrationPhase;
}

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
  status?: string;
  authProvider: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class CreateWalletOrchestratorRequest {
  @IsString()
  @MinLength(1)
  userId: string;

  @IsEnum(WalletNetwork)
  network: WalletNetwork;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
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

export interface OrchestratorListFilters {
  userId?: string;
  network?: WalletNetwork;
  status?: WalletStatus;
  limit?: number;
  offset?: number;
}

export interface OrchestratorListResult {
  data: Wallet[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
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
export class WalletCreationOrchestrator implements OnModuleDestroy {
  private readonly logger = new SafeLogger(WalletCreationOrchestrator.name);
  private prisma: PrismaClient;

  /** Idempotency records for wallet operations are retained for 24 hours. */
  private readonly IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private encryptionService: EncryptionService,
    private configService: ConfigService,
    private idempotentUserService: IdempotentUserService,
    private keyManagementService: KeyManagementService,
    prismaClient?: PrismaClient,
    @Optional() private cacheService?: CacheService,
    @Optional() private webhookEventEmitter?: WebhookEventEmitterService,
    @Optional() private walletRetryService?: WalletRetryService,
    @Optional() private walletApiMetrics?: WalletApiMetricsService,
    @Optional() private orchestratorMetrics?: WalletOrchestratorMetricsService,
  ) {
    this.prisma = prismaClient ?? new PrismaClient({} as any);
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
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
    requestId?: string,
  ): Promise<WalletOrchestrationResult> {
    const resolvedRequestId = requestId || RequestContextService.getCurrentRequestId();
    const requestIdLabel = resolvedRequestId ? ` (requestId=${resolvedRequestId})` : '';
    const startTime = Date.now();
    let committedWallet: Wallet | undefined;
    this.logger.log(
      `Starting wallet creation orchestration for user ${request.userId} on ${request.network}${requestIdLabel}`,
    );

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // --- Phase: user-resolution ---
        const context = await this.buildOrchestrationContext(request, tx);

        // --- Phase: idempotency-check ---
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
            this.emitMetrics({
              userId: request.userId,
              network: request.network,
              outcome: 'idempotent',
              durationMs: Date.now() - startTime,
              requestId: resolvedRequestId,
            });
            return existingResult;
          }
        }

        // Enforce one wallet per user per network
        if (context.existingWallet) {
          this.logger.log(
            `User ${request.userId} already has wallet on ${request.network}`,
          );
          this.emitMetrics({
            userId: request.userId,
            network: request.network,
            outcome: 'existing',
            durationMs: Date.now() - startTime,
            requestId: resolvedRequestId,
          });
          return {
            wallet: context.existingWallet,
            privateKey: '',
            isNewWallet: false,
            idempotencyKey: request.idempotencyKey,
          };
        }

        // Create new wallet in PROVISIONING status (Issue #188)
        const newWallet = await this.createNewWallet(context, tx);

        // Fund testnet account on create (Issue #187)
        if (request.network === WalletNetwork.TESTNET) {
          await this.fundTestnetAccount(newWallet.wallet.publicKey);
        }

        // Transition PROVISIONING -> ACTIVE (Issue #188)
        const activatedWallet = await this.activateWallet(
          newWallet.wallet.id,
          tx,
        );

        const result: WalletOrchestrationResult = {
          wallet: activatedWallet,
          privateKey: newWallet.privateKey,
          isNewWallet: true,
          idempotencyKey: request.idempotencyKey,
        };

        // --- Phase: idempotency-store ---
        if (request.idempotencyKey) {
          await this.storeIdempotencyRecord(
            request.idempotencyKey,
            result,
            request,
            tx,
          );
        }

        this.emitMetrics({
          userId: request.userId,
          network: request.network,
          outcome: 'created',
          durationMs: Date.now() - startTime,
          phases: newWallet.phaseTimings,
          requestId: resolvedRequestId,
        });

        // This is set only on the original transaction path, never for an
        // existing wallet or idempotency replay. Events are emitted below,
        // after `$transaction` has committed successfully.
        committedWallet = activatedWallet;

        return result;
      });

      if (committedWallet) {
        const wallet = committedWallet;
        this.emitDomainEvent('wallet.created', () =>
          this.webhookEventEmitter?.emitWalletCreated({
            walletId: wallet.id,
            userId: wallet.userId,
            publicKey: wallet.publicKey,
            network: wallet.network,
            status: wallet.status,
          }),
        );
        this.emitDomainEvent('wallet.activated', () =>
          this.webhookEventEmitter?.emitWalletActivated({
            walletId: wallet.id,
            userId: wallet.userId,
            publicKey: wallet.publicKey,
          }),
        );
      }

      return result;
    } catch (error) {
      const failedPhase =
        error instanceof WalletOrchestrationError ? error.phase : undefined;

      this.emitMetrics({
        userId: request.userId,
        network: request.network,
        outcome: 'failed',
        durationMs: Date.now() - startTime,
        failedPhase,
        requestId: resolvedRequestId,
      });

      this.logger.error(
        `Wallet creation orchestration failed for user ${request.userId} requestId=${resolvedRequestId || 'N/A'}:`,
        error,
      );

      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
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

  private emitMetrics(metrics: OrchestratorMetrics): void {
    const parts = [
      `outcome=${metrics.outcome}`,
      `userId=${metrics.userId}`,
      `network=${metrics.network}`,
      `durationMs=${metrics.durationMs}`,
    ];
    if (metrics.requestId) {
      parts.push(`requestId=${metrics.requestId}`);
    }
    if (metrics.failedPhase) parts.push(`failedPhase=${metrics.failedPhase}`);
    if (metrics.phases) {
      for (const [phase, ms] of Object.entries(metrics.phases)) {
        parts.push(`phase.${phase}=${ms}ms`);
      }
    }
    const line = `[orchestrator-metrics] ${parts.join(' ')}`;
    if (metrics.outcome === 'failed') {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
    this.walletApiMetrics?.record({
      operation: 'orchestrate_create',
      outcome: metrics.outcome === 'failed' ? 'failure' : metrics.outcome,
      durationMs: metrics.durationMs,
      network: metrics.network,
    });
    this.orchestratorMetrics?.record({
      outcome: metrics.outcome,
      durationMs: metrics.durationMs,
      network: metrics.network,
      failedPhase: metrics.failedPhase,
    });
  }

  /**
   * Removes stale PROVISIONING wallets older than `olderThanMs` milliseconds.
   * Call this from a scheduled job or on startup to recover from crashed orchestrations.
   */
  async cleanupStaleProvisioningWallets(
    olderThanMs = 5 * 60 * 1000,
  ): Promise<number> {
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
    const cacheKey = this.buildWalletCacheKey(userId, network);
    const cached = this.cacheService?.get<Wallet>(cacheKey);
    if (cached) {
      this.logger.log(`Cache hit for existing wallet check: ${cacheKey}`);
      return cached;
    }

    const existingWallet = await tx.wallet.findFirst({
      where: { userId, network },
    });

    if (existingWallet) {
      this.cacheService?.set(cacheKey, this.mapPrismaWalletToDomain(existingWallet));
    }
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
  ): Promise<{
    wallet: Wallet;
    privateKey: string;
    phaseTimings: Partial<Record<OrchestrationPhase, number>>;
  }> {
    const { request } = context;
    const phaseTimings: Partial<Record<OrchestrationPhase, number>> = {};

    // Phase: key-generation + key-encryption via KeyManagementService
    let encryptedKeyMaterial: {
      publicKey: string;
      encryptedData: string;
      encryptionVersion: number;
    };
    let privateKey: string;
    try {
      const t = Date.now();
      encryptedKeyMaterial = await this.generateKeyWithRetry({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: request.userId, network: request.network },
      });
      privateKey = this.encryptionService.deserializeAndDecrypt(
        encryptedKeyMaterial.encryptedData,
      );
      phaseTimings['key-generation'] = Date.now() - t;
      phaseTimings['key-encryption'] = 0;
    } catch (error) {
      throw new WalletOrchestrationError(
        'Key generation failed',
        'key-generation',
        error,
      );
    }

    // Phase: wallet-persist (PROVISIONING)
    let provisioningWallet: any;
    try {
      const t = Date.now();
      provisioningWallet = await tx.wallet.create({
        data: {
          userId: request.userId,
          publicKey: encryptedKeyMaterial.publicKey,
          encryptedSecret: encryptedKeyMaterial.encryptedData,
          network: request.network,
          status: 'PROVISIONING',
          encryptionVersion: encryptedKeyMaterial.encryptionVersion,
          secretVersion: 1,
          keyVersion: 1,
        },
      });
      phaseTimings['wallet-persist'] = Date.now() - t;
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
      const t = Date.now();
      activatedWallet = await tx.wallet.update({
        where: { id: provisioningWallet.id },
        data: {
          status: WalletStatus.ACTIVE,
          statusChangedAt: new Date(),
        },
      });
      phaseTimings['wallet-activation'] = Date.now() - t;
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
      privateKey,
      phaseTimings,
    };
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
    if (
      cached.userId !== request.userId ||
      cached.network !== request.network
    ) {
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
      keyVersion: prismaWallet.keyVersion ?? 1,
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
    requestId?: string,
  ): Promise<Wallet | null> {
    const resolvedRequestId = requestId || RequestContextService.getCurrentRequestId();
    this.logger.log(
      `Looking up wallet for user ${userId} on ${network}${resolvedRequestId ? ` (requestId=${resolvedRequestId})` : ''}`,
    );

    const cacheKey = this.buildWalletCacheKey(userId, network);
    const cached = this.cacheService?.get<Wallet>(cacheKey);
    if (cached) {
      this.logger.log(`Cache hit for wallet lookup: ${cacheKey}`);
      return cached;
    }

    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });

    const result = wallet ? this.mapPrismaWalletToDomain(wallet) : null;
    if (result) {
      this.cacheService?.set(cacheKey, result);
    }
    return result;
  }

  /**
   * Validates user can create wallet on specified network
   */
  async validateUserCanCreateWallet(
    userId: string,
    network: WalletNetwork,
    requestId?: string,
  ): Promise<boolean> {
    const resolvedRequestId = requestId || RequestContextService.getCurrentRequestId();
    this.logger.log(
      `Validating wallet creation for user ${userId} on ${network}${resolvedRequestId ? ` (requestId=${resolvedRequestId})` : ''}`,
    );
    const existingWallet = await this.getWalletByUser(userId, network, resolvedRequestId);
    return existingWallet === null;
  }

  // ──────────────────────────────────────────────
  // #187: Fund testnet account on create
  // ──────────────────────────────────────────────

  /**
   * Funds a testnet account using Stellar Friendbot.
   * For TESTNET wallets, this adds initial XLM for transaction fees.
   */
  private async fundTestnetAccount(publicKey: string): Promise<void> {
    const horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );

    // Friendbot endpoint is specific to Stellar testnet
    const friendbotUrl = `https://friendbot.stellar.org?addr=${publicKey}`;

    try {
      this.logger.log(
        `Funding testnet account ${publicKey.substring(0, 8)}... via Friendbot`,
      );

      const response = await this.fetchWithRetry(friendbotUrl);

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.warn(
          `Friendbot funding responded with status ${response.status}: ${errorBody}`,
        );
        // Friendbot can sometimes return errors for already-funded accounts;
        // we don't want to fail the entire flow
        return;
      }

      this.logger.log(
        `Successfully funded testnet account ${publicKey.substring(0, 8)}...`,
      );
    } catch (error) {
      // Network errors during Friendbot calls should not block wallet creation
      this.logger.warn(
        `Friendbot funding request failed for ${publicKey.substring(0, 8)}... : ${String(error)}`,
      );
      // Non-blocking: wallet is already created in PROVISIONING state
    }
  }

  /**
   * Returns the wallet status response (public helper).
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
   * Returns all wallets for a given userId (public helper).
   */
  async findWalletsByUserId(userId: string): Promise<Wallet[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return wallets.map((w) => this.mapPrismaWalletToDomain(w));
  }

  /**
   * Lists wallets with optional filtering and offset-based pagination.
   * Results are ordered newest-first.
   */
  async listWallets(
    filters?: OrchestratorListFilters,
  ): Promise<OrchestratorListResult> {
    const where: Record<string, unknown> = {};
    if (filters?.userId) where.userId = filters.userId;
    if (filters?.network) where.network = filters.network;
    if (filters?.status) where.status = filters.status;

    const limit = filters?.limit ?? 20;
    const offset = filters?.offset ?? 0;

    const [wallets, total] = await Promise.all([
      this.prisma.wallet.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.wallet.count({ where }),
    ]);

    return {
      data: wallets.map((w: any) => this.mapPrismaWalletToDomain(w)),
      total,
      limit,
      offset,
      hasMore: offset + wallets.length < total,
    };
  }

  /**
   * Transitions a PROVISIONING wallet to ACTIVE within a transaction.
   */
  private async activateWallet(walletId: string, tx: any): Promise<Wallet> {
    try {
      const updatedWallet = await tx.wallet.update({
        where: { id: walletId },
        data: {
          status: 'ACTIVE',
          statusReason: 'Wallet provisioned and activated',
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.log(`Activated wallet ${walletId} (PROVISIONING -> ACTIVE)`);

      return this.mapPrismaWalletToDomain(updatedWallet);
    } catch (error) {
      this.logger.error(`Failed to activate wallet ${walletId}:`, error);
      throw new Error('Wallet activation within transaction failed');
    }
  }

  private async generateKeyWithRetry(request: {
    keyType: KeyType;
    metadata: Record<string, unknown>;
  }) {
    if (!this.walletRetryService) {
      return this.keyManagementService.generateKey(request);
    }
    return this.walletRetryService.execute(
      { operation: 'orchestration_key_generation' },
      () => this.keyManagementService.generateKey(request),
    );
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    const request = async (): Promise<Response> => {
      const response = await requestIdAwareFetch(url, { method: 'GET' });
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        const error = Object.assign(
          new Error(`Friendbot responded with status ${response.status}`),
          { status: response.status },
        );
        throw error;
      }
      return response;
    };
    if (!this.walletRetryService) return request();
    return this.walletRetryService.execute({ operation: 'testnet_funding' }, request);
  }

  /**
   * Builds a consistent cache key for wallet lookups.
   */
  private buildWalletCacheKey(userId: string, network: WalletNetwork): string {
    return `wallet:user:${userId}:${network}`;
  }

  /**
   * Invalidates the wallet cache entry for a given user and network.
   */
  private invalidateWalletCache(userId: string, network: WalletNetwork): void {
    const cacheKey = this.buildWalletCacheKey(userId, network);
    this.cacheService?.delete(cacheKey);
    this.logger.log(`Invalidated cache key: ${cacheKey}`);
  }

  /** A failed webhook dispatch is observable but cannot roll back a wallet. */
  private emitDomainEvent(
    eventName: string,
    emit: () => Promise<void> | undefined,
  ): void {
    void Promise.resolve(emit()).catch((error: unknown) =>
      this.logger.warn(`Unable to emit ${eventName} domain event: ${String(error)}`),
    );
  }
}
