import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import {
  Wallet,
  WalletNetwork,
  WalletStatus,
  WalletStatusResponse,
} from './domain/wallet.model';
import {
  DecryptionError,
  EncryptionService,
} from '../encryption/encryption.service';
import { SafeLogger } from '../common/safe-logger';
import { KeyDecryptionException } from '../key-management/exceptions/key-decryption.exception';
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import {
  WalletApiMetricsService,
  type WalletApiOperation,
} from './wallet-api-metrics.service';
import { WalletRetryService } from './wallet-retry.service';
import * as crypto from 'crypto';
import { TransactionBuilder, Keypair } from 'stellar-sdk';
import {
  StructuredLogger,
  LogContext,
} from '../common/logging/structured-logger';
import { TransactionStatus } from '../transactions/domain/transaction.model';

/** Wallet shape safe to return from the API (no encrypted secret material). */
export type PublicWallet = Omit<Wallet, 'encryptedSecret'>;

export interface CreateWalletRequest {
  userId: string;
  network: WalletNetwork;
}

export interface WalletListFilters {
  userId?: string;
  network?: WalletNetwork;
  status?: WalletStatus;
  /** Include archived wallets in the results (excluded by default). */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  /** Enable load test synthetic data generation. */
  loadTestMode?: boolean;
}

export interface WalletListResult {
  data: PublicWallet[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface WalletCreationResult {
  wallet: Wallet;
  privateKey: string;
}

/**
 * Result of a wallet key rotation (issue #692).
 *
 * Rotation uses the successor model: a new wallet is created with fresh key
 * material and the predecessor is transitioned to `ROTATING` with its
 * `successorId` set. No private key is returned — key material never leaves the
 * key-management boundary.
 */
export interface WalletKeyRotationResult {
  /** The predecessor wallet, now `ROTATING` with `successorId` populated. */
  predecessor: PublicWallet;
  /** The freshly created successor wallet holding the new key. */
  successor: PublicWallet;
}

export interface SigningResult {
  signature: string;
  transactionHash?: string;
}

@Injectable()
export class WalletsService implements OnModuleDestroy {
  private readonly logger = new StructuredLogger(WalletsService.name);
  private prisma: PrismaClient;

  constructor(
    private encryptionService: EncryptionService,
    private configService: ConfigService,
    private keyManagementService: KeyManagementService,
    @Optional() private webhookEventEmitter?: WebhookEventEmitterService,
    @Optional() private walletRetryService?: WalletRetryService,
    @Optional() private walletApiMetrics?: WalletApiMetricsService,
  ) {
    this.prisma = new PrismaClient({} as any);
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }

  async onModuleInit() {
    if (!this.encryptionService.validateConfiguration()) {
      throw new Error('Wallet encryption service configuration is invalid');
    }
    this.logger.logWithContext('Wallet service initialized', {
      operation: 'init',
      outcome: 'success',
    });
  }

  /**
   * Creates a new wallet for the given user/network.
   *
   * #494 Rollback strategy:
   * - All DB and key operations are wrapped in a Prisma transaction.
   * - If Horizon funding fails (TESTNET), the error is caught and logged; the
   *   wallet creation does NOT roll back because funding is best-effort.
   * - If key generation or DB persistence fails, the transaction rolls back
   *   automatically, leaving no partial wallet record.
   */
  async createWallet(
    request: CreateWalletRequest,
  ): Promise<WalletCreationResult> {
    const startedAt = Date.now();
    const { userId, network } = request;

    const existingWallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });
    if (existingWallet) {
      throw new ConflictException(`User already has a wallet on ${network}`);
    }

    let wallet: Wallet;
    let privateKey: string;

    try {
      // Key generation (outside the DB transaction so we can roll back cleanly)
      const key = await this.generateKeyWithRetry('key_generation', {
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId, network },
      });
      privateKey = this.encryptionService.deserializeAndDecrypt(
        key.encryptedData,
      );

      // Atomic DB write — rolled back automatically if anything throws
      const created = await this.prisma.$transaction(async (tx) => {
        return tx.wallet.create({
          data: {
            userId,
            publicKey: key.publicKey,
            encryptedSecret: key.encryptedData,
            network,
            status: WalletStatus.ACTIVE,
            encryptionVersion: key.encryptionVersion,
            secretVersion: 1,
            keyVersion: 1,
          },
        });
      });

      wallet = this.mapPrismaWalletToDomain(created);
    } catch (error) {
      // Prisma P2002: unique constraint violation on (network, publicKey)
      // This should be extraordinarily rare (key-space collision) but must be
      // handled explicitly so callers receive a clear 409 rather than a 500.
      if (
        error &&
        typeof error === 'object' &&
        (error as any).code === 'P2002' &&
        (error as any).meta?.target?.includes('publicKey')
      ) {
        this.logger.error(
          `Public key collision detected during wallet creation for user ${userId} on ${network}`,
        );
        this.recordMetric('create', 'failure', startedAt, network);
        throw new ConflictException(
          `The generated public key already exists on ${network}. Please retry — a new unique key will be generated.`,
        );
      }
      this.logger.error('Failed to create wallet:', error);
      this.recordMetric('create', 'failure', startedAt, network);
      throw new Error('Wallet creation failed');
    }

    this.emitDomainEvent('wallet.created', () =>
      this.webhookEventEmitter?.emitWalletCreated({
        walletId: wallet.id,
        userId: wallet.userId,
        publicKey: wallet.publicKey,
        network: wallet.network,
        status: wallet.status,
      }),
    );
    this.recordMetric('create', 'success', startedAt, network);
    return { wallet, privateKey };
  }

  async findWalletById(walletId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });
    if (!wallet)
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    return this.mapPrismaWalletToDomain(wallet);
  }

  /**
   * Look up a wallet by its Stellar public key (address) and network.
   *
   * Address uniqueness is enforced at the DB level via the
   * @@unique([network, publicKey]) constraint.  This method provides an
   * explicit, human-readable lookup path for consumers who know the on-chain
   * address but not the internal wallet ID.
   *
   * @param publicKey  Stellar public key (G-address or M-address).
   * @param network    Network the key lives on (MAINNET / TESTNET).
   * @throws NotFoundException when no wallet with that key exists on the network.
   */
  async findByPublicKey(
    publicKey: string,
    network: WalletNetwork,
  ): Promise<PublicWallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { network_publicKey: { network, publicKey } },
    });
    if (!wallet) {
      throw new NotFoundException(
        `No wallet found for public key ${publicKey} on ${network}`,
      );
    }
    return this.toPublicWallet(this.mapPrismaWalletToDomain(wallet));
  }

  /**
   * Check whether a public key is already registered on a given network.
   *
   * Returns true if the address is taken, false if it is available.
   * Useful for pre-creation validation before key generation.
   */
  async isPublicKeyTaken(
    publicKey: string,
    network: WalletNetwork,
  ): Promise<boolean> {
    const count = await this.prisma.wallet.count({
      where: { publicKey, network },
    });
    return count > 0;
  }

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

  async getDecryptedPrivateKey(walletId: string): Promise<string> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });
    if (!wallet)
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    if (wallet.status !== 'ACTIVE') {
      throw new Error(`Cannot sign with wallet in status: ${wallet.status}`);
    }
    try {
      return this.encryptionService.deserializeAndDecrypt(
        wallet.encryptedSecret,
      );
    } catch (error) {
      if (error instanceof DecryptionError) {
        throw new KeyDecryptionException(
          walletId,
          error.code,
          'Wallet key decryption failed — the key material may be corrupted or the encryption key may have changed',
        );
      }
      this.logger.error(
        `Unexpected error decrypting wallet ${walletId}:`,
        error,
      );
      throw new Error('Failed to access wallet private key');
    }
  }

  async signTransaction(
    walletId: string,
    transactionData: string,
  ): Promise<SigningResult> {
    try {
      const privateKey = await this.getDecryptedPrivateKey(walletId);
      return {
        signature: this.signWithPrivateKey(privateKey, transactionData),
      };
    } catch (error) {
      this.logger.error(
        `Failed to sign transaction with wallet ${walletId}:`,
        error,
      );
      throw new Error('Transaction signing failed');
    }
  }

  async signStellarEnvelope(walletId: string, unsignedXdr: string): Promise<string> {
    const privateKey = await this.getDecryptedPrivateKey(walletId);
    try {
      const transaction = TransactionBuilder.fromXDR(
        unsignedXdr,
        this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE'),
      );
      transaction.sign(Keypair.fromSecret(privateKey));
      return transaction.toEnvelope().toXDR('base64');
    } catch {
      throw new Error('Stellar transaction signing failed');
    }
  }

  async rotateWalletKey(walletId: string): Promise<WalletCreationResult> {
    const startedAt = Date.now();
    const existing = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });
    if (!existing)
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    try {
      const rotation = await this.keyManagementService.rotateKey(walletId);

      const [predecessorRecord, successorRecord] = await Promise.all([
        this.prisma.wallet.findUnique({
          where: { id: rotation.predecessorWalletId },
        }),
        this.prisma.wallet.findUnique({
          where: { id: rotation.successorWalletId },
        }),
      ]);

      if (!predecessorRecord || !successorRecord) {
        throw new Error(
          'Rotation completed but wallet records could not be read',
        );
      }

      const successor = this.mapPrismaWalletToDomain(successorRecord);
      const predecessor = this.mapPrismaWalletToDomain(predecessorRecord);

      this.emitDomainEvent('wallet.rotated', () =>
        this.webhookEventEmitter?.emitWalletRotated({
          walletId: successor.id,
          userId: successor.userId,
          publicKey: successor.publicKey,
          network: successor.network,
          secretVersion: successor.secretVersion,
        }),
      );
      this.recordMetric('key_rotate', 'success', startedAt, successor.network);

      return {
        predecessor: this.toPublicWallet(predecessor),
        successor: this.toPublicWallet(successor),
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to rotate wallet ${walletId}:`, error);
      this.recordMetric(
        'key_rotate',
        'failure',
        startedAt,
        existing.network as WalletNetwork,
      );
      throw new Error('Wallet key rotation failed');
    }
  }

  async updateWalletStatus(
    walletId: string,
    status: WalletStatus,
    reason?: string,
  ): Promise<Wallet> {
    const startedAt = Date.now();
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });
    if (!wallet)
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);

    const currentStatus = wallet.status as WalletStatus;

    if (
      currentStatus !== status &&
      !canTransitionWalletStatus(currentStatus, status)
    ) {
      throw new ConflictException(
        `Invalid wallet status transition: ${currentStatus} -> ${status}`,
      );
    }

    try {
      const updated = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          status,
          statusReason: reason,
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const mapped = this.mapPrismaWalletToDomain(updated);
      if (status === WalletStatus.SUSPENDED) {
        this.emitDomainEvent('wallet.suspended', () =>
          this.webhookEventEmitter?.emitWalletSuspended({
            walletId: mapped.id,
            userId: mapped.userId,
            reason,
          }),
        );
      }
      this.recordMetric('status_update', 'success', startedAt, mapped.network);
      return mapped;
    } catch (error) {
      this.logger.error(`Failed to update wallet ${walletId} status:`, error);
      this.recordMetric(
        'status_update',
        'failure',
        startedAt,
        wallet.network as WalletNetwork,
      );
      throw new Error('Wallet status update failed');
    }
  }

  async getWalletStatus(walletId: string): Promise<WalletStatusResponse> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });
    if (!wallet)
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
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

  async activateWallet(
    walletId: string,
    statusReason?: string,
  ): Promise<Wallet> {
    const startedAt = Date.now();
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });
    if (!wallet)
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    if (wallet.status !== 'PROVISIONING') {
      throw new Error(
        `Cannot activate wallet in status: ${wallet.status}. Only PROVISIONING wallets can be activated.`,
      );
    }
    try {
      const updated = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          status: 'ACTIVE',
          statusReason: statusReason ?? 'Wallet provisioned and activated',
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const mapped = this.mapPrismaWalletToDomain(updated);
      this.emitDomainEvent('wallet.activated', () =>
        this.webhookEventEmitter?.emitWalletActivated({
          walletId: mapped.id,
          userId: mapped.userId,
          publicKey: mapped.publicKey,
        }),
      );
      this.recordMetric('activate', 'success', startedAt, mapped.network);
      return mapped;
    } catch (error) {
      this.logger.error(`Failed to activate wallet ${walletId}:`, error);
      this.recordMetric(
        'activate',
        'failure',
        startedAt,
        wallet.network as WalletNetwork,
      );
      throw new Error('Wallet activation failed');
    }
  }

  async findWalletsByUserId(userId: string): Promise<Wallet[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return wallets.map((wallet) => this.mapPrismaWalletToDomain(wallet));
  }

  /** Retrieves the user's persisted default network preference (null if unset). */
  async getNetworkPreference(userId: string): Promise<{
    userId: string;
    defaultNetwork: WalletNetwork | null;
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User with ID ${userId} not found`);
    return {
      userId: user.id,
      defaultNetwork: (user.defaultNetwork as WalletNetwork) ?? null,
    };
  }

  /** Persists the user's default network preference for future wallet operations. */
  async setNetworkPreference(
    userId: string,
    network: WalletNetwork,
  ): Promise<{ userId: string; defaultNetwork: WalletNetwork }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User with ID ${userId} not found`);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { defaultNetwork: network },
    });

    this.logger.logWithContext('Set network preference', {
      userId,
      entityType: 'user',
      operation: 'set_network_preference',
      outcome: 'success',
    });
    return {
      userId: updated.id,
      defaultNetwork: updated.defaultNetwork as WalletNetwork,
    };
  }

  /**
   * #496: List wallets with optional filtering and offset-based pagination.
   * Results are ordered newest-first. Archived wallets are excluded by default.
   */
  async findAll(filters?: WalletListFilters): Promise<WalletListResult> {
    // #696: `loadTestMode` returns synthetic wallet data for local performance
    // testing only. It must never be reachable in production — a public caller
    // could otherwise pull fabricated wallet records from the `/v1` API.
    if (filters?.loadTestMode) {
      if (process.env.NODE_ENV === 'production') {
        throw new ForbiddenException(
          'loadTestMode is not available in this environment',
        );
      }
      this.logger.warn(
        'Serving synthetic wallet data (loadTestMode=true) — non-production only',
      );
      return this.generateTestData(filters);
    }

    const where: Record<string, unknown> = {};

    if (filters?.userId) {
      where.userId = filters.userId;
    }
    if (filters?.network) {
      where.network = filters.network;
    }
    if (filters?.status) {
      where.status = filters.status;
    } else if (!filters?.includeArchived) {
      where.status = { not: WalletStatus.ARCHIVED };
    }

    const limit = Math.min(filters?.limit ?? 20, 100);
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
      data: wallets.map((wallet) =>
        this.toPublicWallet(this.mapPrismaWalletToDomain(wallet)),
      ),
      total,
      limit,
      offset,
      hasMore: offset + wallets.length < total,
    };
  }

  /** Convenience alias used by the controller for the basic CRUD route. */
  create(createWalletDto: any): Promise<WalletCreationResult> {
    return this.createWallet(createWalletDto);
  }

  async findOne(id: string): Promise<PublicWallet> {
    const wallet = await this.findWalletById(id);
    return this.toPublicWallet(wallet);
  }

  async update(id: string, updateWalletDto: any): Promise<PublicWallet> {
    const wallet = await this.updateWalletStatus(id, updateWalletDto.status);
    return this.toPublicWallet(wallet);
  }

  /**
   * Set or clear the human-readable nickname for a wallet.
   *
   * Nicknames are sanitized before persistence (so they are safe to render in
   * dashboards) and must be unique among the non-archived wallets owned by the
   * same user. Pass `null` (or a value that sanitizes to empty) to clear the
   * nickname; clearing never triggers the uniqueness check.
   *
   * @param walletId  ID of the wallet to update.
   * @param nickname  New label (max 100 chars), or null/undefined to clear.
   * @param requestId Request ID for log/metric correlation.
   * @returns Updated public wallet (without encrypted secret).
   */
  async updateNickname(
    walletId: string,
    nickname: string | null | undefined,
    requestId?: string,
  ): Promise<PublicWallet> {
    const startedAt = Date.now();
    const existing = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });
    if (!existing) {
      throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    }

    // Normalize before checking uniqueness so the stored value is exactly what
    // is verified. An empty/null/whitespace-after-sanitize input clears.
    const sanitized =
      nickname === null || nickname === undefined
        ? null
        : this.sanitizeNickname(nickname);
    const nextNickname =
      sanitized !== null && sanitized.length > 0 ? sanitized : null;

    // Per-owner uniqueness: the label must be unique across the non-archived
    // wallets the same user owns (excluding this wallet). Comparison is
    // case-insensitive so "Savings" and "savings" cannot coexist.
    if (nextNickname !== null) {
      const duplicate = await this.prisma.wallet.findFirst({
        where: {
          userId: existing.userId,
          nickname: { equals: nextNickname, mode: 'insensitive' },
          id: { not: walletId },
          status: { not: WalletStatus.ARCHIVED },
        },
      });
      if (duplicate) {
        this.logger.warnWithContext('Rejected duplicate wallet nickname', {
          operation: 'update_nickname',
          entityType: 'wallet',
          entityId: walletId,
          requestId,
          userId: existing.userId,
          outcome: 'conflict',
        });
        this.recordMetric(
          'update_nickname',
          'failure',
          startedAt,
          existing.network as WalletNetwork,
        );
        throw new ConflictException(
          'Wallet nickname is already in use for this wallet owner',
        );
      }
    }

    const updated = await this.prisma.wallet.update({
      where: { id: walletId },
      data: {
        nickname: nextNickname,
        updatedAt: new Date(),
      },
    });

    this.logger.logWithContext('Updated wallet nickname', {
      operation: 'update_nickname',
      entityType: 'wallet',
      entityId: walletId,
      requestId,
      userId: existing.userId,
      outcome: 'success',
    });

    this.recordMetric(
      'update_nickname',
      'success',
      startedAt,
      existing.network as WalletNetwork,
    );

    return this.toPublicWallet(this.mapPrismaWalletToDomain(updated));
  }

  /**
   * Sanitize a user-supplied wallet nickname for safe rendering.
   *
   * Defensive deny-list against stored-XSS: strips HTML tag-like sequences,
   * drops `javascript:` URL schemes, removes inline `on*` event-handler
   * attributes, and discards control characters before the value is persisted
   * or returned to the dashboard. Only ever contains the label text afterwards.
   */
  private sanitizeNickname(value: string): string {
    return value
      .replace(/<[^>]*>/g, ' ')
      .replace(/javascript\s*:/gi, '')
      .replace(/\s+on\w*\s*=/gi, ' ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim();
  }

  /**
   * Deletes a wallet, guarding against removal while transactions are still
   * in flight.
   *
   * #558: A wallet with PENDING or SUBMITTED transactions (sent or received)
   * must not be deleted — the underlying transaction record would be left
   * referencing a wallet that no longer exists, and any in-progress Stellar
   * submission/settlement could silently lose its owning wallet context.
   * Only wallets whose transactions have all reached a terminal state
   * (CONFIRMED / FAILED) — or that have none at all — may be deleted.
   */
  async remove(id: string): Promise<PublicWallet> {
    const wallet = await this.prisma.wallet.findUnique({ where: { id } });
    if (!wallet) {
      throw new NotFoundException(`Wallet with ID ${id} not found`);
    }

    const pendingTransactionCount = await this.prisma.transaction.count({
      where: {
        OR: [{ senderWalletId: id }, { receiverWalletId: id }],
        status: {
          in: [TransactionStatus.PENDING, TransactionStatus.SUBMITTED],
        },
      },
    });

    if (pendingTransactionCount > 0) {
      this.logger.logWithContext(
        'Blocked wallet deletion: pending transactions exist',
        {
          operation: 'remove',
          entityType: 'wallet',
          entityId: id,
          outcome: 'blocked',
        },
      );
      throw new ConflictException(
        `Cannot delete wallet ${id}: ${pendingTransactionCount} pending transaction(s) must settle first`,
      );
    }

    const deleted = await this.prisma.wallet.delete({ where: { id } });

    this.logger.logWithContext('Deleted wallet', {
      operation: 'remove',
      entityType: 'wallet',
      entityId: id,
      outcome: 'success',
    });

    return this.toPublicWallet(this.mapPrismaWalletToDomain(deleted));
  }

  async archive(id: string, reason?: string): Promise<PublicWallet> {
    const wallet = await this.archiveWallet(id, reason);
    return this.toPublicWallet(wallet);
  }

  async archiveWallet(walletId: string, reason?: string): Promise<Wallet> {
    return this.updateWalletStatus(
      walletId,
      WalletStatus.ARCHIVED,
      reason ?? 'Wallet archived',
    );
  }

  private generateTestData(filters: WalletListFilters): WalletListResult {
    const limit = Math.min(filters?.limit ?? 20, 100);
    const offset = filters?.offset ?? 0;
    const totalTestWallets = 1000;

    const testWallets: PublicWallet[] = Array.from({ length: limit }, (_, i) => {
      const index = offset + i;
      return {
        id: `test-wallet-${index}`,
        userId: `test-user-${index % 100}`,
        publicKey: `0x${'a'.repeat(64)}${index.toString().padStart(2, '0')}`,
        encryptionVersion: 1,
        secretVersion: 1,
        keyVersion: 1,
        network: (index % 2 === 0 ? WalletNetwork.MAINNET : WalletNetwork.TESTNET) as WalletNetwork,
        status: WalletStatus.ACTIVE as WalletStatus,
        statusReason: 'Test wallet',
        statusChangedAt: new Date(Date.now() - index * 1000),
        rotatedFromId: null,
        successorId: null,
        createdAt: new Date(Date.now() - index * 1000),
        updatedAt: new Date(Date.now() - index * 1000),
      };
    });

    return {
      data: testWallets,
      total: totalTestWallets,
      limit,
      offset,
      hasMore: offset + limit < totalTestWallets,
    };
  }

  private toPublicWallet(wallet: Wallet): PublicWallet {
    const { encryptedSecret: _encryptedSecret, ...publicWallet } = wallet;
    return publicWallet;
  }

  private signWithPrivateKey(privateKey: string, data: string): string {
    const key = crypto.createPrivateKey({
      key: Buffer.from(privateKey, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    return crypto.sign('sha256', Buffer.from(data), key).toString('hex');
  }

  private async generateKeyWithRetry(
    operation: string,
    request: { keyType: KeyType; metadata: Record<string, unknown> },
  ) {
    if (!this.walletRetryService)
      return this.keyManagementService.generateKey(request);
    return this.walletRetryService.execute({ operation }, () =>
      this.keyManagementService.generateKey(request),
    );
  }

  private emitDomainEvent(
    eventName: string,
    emit: () => Promise<void> | undefined,
  ): void {
    void Promise.resolve(emit()).catch((error: unknown) =>
      this.logger.warn(
        `Unable to emit ${eventName} domain event: ${String(error)}`,
      ),
    );
  }

  private recordMetric(
    operation: WalletApiOperation,
    outcome: 'success' | 'failure',
    startedAt: number,
    network?: WalletNetwork,
  ): void {
    this.walletApiMetrics?.record({
      operation,
      outcome,
      durationMs: Date.now() - startedAt,
      network,
    });
  }

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
      nickname: prismaWallet.nickname ?? null,
      createdAt: prismaWallet.createdAt,
      updatedAt: prismaWallet.updatedAt,
    };
  }
}
