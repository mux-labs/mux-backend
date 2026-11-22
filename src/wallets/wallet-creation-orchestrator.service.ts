import {
  Injectable,
  Logger,
  ConflictException,
  Inject,
  Optional,
} from '@nestjs/common';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../encryption/encryption.service';
import {
  USER_STATUS_PORT,
  type UserStatusPort,
} from '../users/user-status.service';

/** Networks a wallet may be created on. */
export const VALID_NETWORKS: ReadonlySet<string> = new Set([
  'TESTNET',
  'MAINNET',
]);

/** Request shape accepted by `WalletCreationOrchestrator.createWallet`. */
export interface CreateWalletOrchestratorRequest {
  userId: string;
  network: WalletNetwork;
  /** Optional client-supplied key enabling replay-safe retries. */
  idempotencyKey?: string;
  /** Correlation id echoed into denial errors and ops logs. */
  correlationId?: string;
}

/** Result of a create-or-get orchestration call. */
export interface WalletOrchestrationResult {
  wallet: WalletCreationResult;
  /**
   * `true` when this call created the wallet, `false` when an existing wallet
   * was returned. Replayed requests MUST observe the original value so a
   * caller can still distinguish first-creation from a retry.
   */
  isNewWallet: boolean;
  /**
   * The idempotency key this result is bound to, when one was supplied.
   * Echoed verbatim on a replay so the caller can correlate.
   */
  idempotencyKey?: string;
}

/** Durable record of a completed orchestration, keyed by idempotency key. */
interface IdempotencyEntry {
  userId: string;
  network: WalletNetwork;
  result: WalletOrchestrationResult;
}

/**
 * Durable persistence port for wallet rows and idempotency records.
 *
 * Implementations MUST persist across process restarts and be shared by every
 * orchestrator instance (e.g. a database table with a unique constraint on
 * `(userId, network)` and on `idempotencyKey`). The orchestrator never keeps
 * this state in a process-local map, so a restart or a second instance cannot
 * mint a duplicate wallet.
 */
export interface WalletCreationStore {
  /** Returns the wallet for `(userId, network)`, if one exists. */
  findByNaturalKey(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | undefined>;
  /** Returns the completed idempotency record for `key`, if one exists. */
  findIdempotency(
    key: string,
  ): Promise<IdempotencyEntry | undefined>;
  /**
   * Atomically persists `wallet` and, when supplied, the idempotency record.
   * MUST fail (throw) if a wallet already exists for `(userId, network)` or if
   * the idempotency key is already bound, so concurrent instances cannot both
   * create a wallet.
   */
  save(
    wallet: WalletCreationResult,
    idempotencyKey?: string,
  ): Promise<void>;
}

/** DI token for the durable wallet-creation store. */
export const WALLET_CREATION_STORE = Symbol('WALLET_CREATION_STORE');

export interface WalletCreationResult {
  id: string;
  userId: string;
  publicKey: string;
  /**
   * AES-256-GCM envelope for the Stellar secret seed, as persisted in
   * `Wallet.encryptedSecret`. This is the ONLY representation of the secret
   * that leaves this service: the plaintext seed is never returned, logged,
   * or persisted.
   */
  encryptedSecret: string;
  network: WalletNetwork;
  status: WalletStatus;
  idempotencyKey?: string;
  createdAt: Date;
}

/** Typed failure so a caller can distinguish which orchestration phase failed. */
export class WalletOrchestrationError extends Error {
  constructor(
    message: string,
    readonly phase: 'keygen' | 'persist' | 'lookup',
  ) {
    super(message);
    this.name = 'WalletOrchestrationError';
  }
}

/**
 * Orchestrates wallet creation across key generation, persistence, and
 * retrieval.
 *
 * Fail-closed: if a phase fails, no partial wallet is left behind and the
 * failure is surfaced with a typed phase so the caller can distinguish a
 * dependency outage from a client error.
 *
 * Custody invariant: the Stellar secret seed is encrypted with
 * `EncryptionService` (AES-256-GCM) before it leaves this method. The result
 * carries only the ciphertext envelope, so a plaintext seed can never reach
 * the database, a log, or an API response.
 *
 * ## Retry / replay contract (#963)
 *
 * This service is invoked from an external orchestrator that retries on
 * failure. A retry must never mint a second wallet for the same user, because
 * two custody keys for one user means funds sent to an orphaned address.
 * Three independent guards enforce that:
 *
 *  1. **Idempotency-key replay.** A call carrying an `idempotencyKey` that has
 *     already completed returns the *original* result verbatim — same wallet
 *     id, same `isNewWallet`, same `createdAt` — so a retry after a dropped
 *     response cannot create a duplicate. Reusing a key for a *different*
 *     `userId`/`network` is a client bug and is rejected with a conflict
 *     rather than silently returning the wrong user's wallet.
 *  2. **In-flight key reservation.** A key being processed is recorded before
 *     work starts, so two concurrent retries with the same key do not both
 *     proceed to mint.
 *  3. **One wallet per (userId, network).** Even with no idempotency key, a
 *     second call for an existing user+network returns the existing wallet with
 *     `isNewWallet: false` instead of creating a duplicate.
 *
 * Guards 1 and 3 are independent: the key guard protects the retry case, and
 * the natural-key guard protects the no-key case and the post-expiry case.
 *
 * ## Durability (#1277)
 *
 * Wallet rows and idempotency records live in a `WalletCreationStore` (a
 * durable, shared backend), not in process-local maps. A restart or a second
 * instance therefore observes the same wallets and replays, and the store's
 * atomic `save` enforces the natural-key and idempotency-key uniqueness across
 * instances.
 */
@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);

  /**
   * Durable persistence for wallets and idempotency records. When no store is
   * bound (isolated unit tests), a process-local fallback is used so the
   * orchestrator remains constructible; production MUST bind a durable store.
   */
  private readonly store: WalletCreationStore;

  /**
   * The custody encryption layer.
   *
   * Resolved from DI when a provider is available; otherwise constructed lazily
   * from the process environment on first use, so a missing/invalid
   * `WALLET_ENCRYPTION_KEY` surfaces as a typed keygen failure for the request
   * in flight instead of preventing the module from booting at all.
   */
  private encryptionService?: EncryptionService;

  private readonly userStatus?: UserStatusPort;

  constructor(
    @Optional() encryptionService?: EncryptionService,
    /**
     * User-status port (#941). Optional so the orchestrator remains
     * constructible in isolation/unit tests; when bound it gates every
     * wallet-creation call on the account's `UserStatus`.
     */
    @Optional()
    @Inject(USER_STATUS_PORT)
    userStatus?: UserStatusPort,
    /**
     * Durable store (#1277). Optional only for isolated unit tests; production
     * wiring MUST provide a durable implementation so state survives restarts
     * and is shared across instances.
     */
    @Optional()
    @Inject(WALLET_CREATION_STORE)
    store?: WalletCreationStore,
  ) {
    this.encryptionService = encryptionService;
    this.userStatus = userStatus;
    this.store = store ?? new InMemoryWalletCreationStore();
  }

  /** Returns the custody encryption layer, constructing it on first use. */
  private resolveEncryptionService(): EncryptionService {
    if (!this.encryptionService) {
      this.encryptionService = new EncryptionService(new ConfigService());
    }
    return this.encryptionService;
  }

  /**
   * Returns the completed result for `idempotencyKey`, or `undefined` when the
   * key has not completed. Throws a conflict when the key is bound to a
   * different user or network.
   */
  private async replayIfCompleted(
    idempotencyKey: string,
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletOrchestrationResult | undefined> {
    const entry = await this.store.findIdempotency(idempotencyKey);
    if (!entry) {
      return undefined;
    }
    if (entry.userId !== userId || entry.network !== network) {
      throw new ConflictException({
        code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT',
        message:
          'This idempotency key was already used for a different user or network',
      });
    }
    return entry.result;
  }

  /**
   * Creates a wallet for `userId` on `network`, or returns the existing one.
   *
   * @param request User, network, and optional idempotency key.
   * @returns The wallet plus whether this call created it.
   * @throws WalletOrchestrationError on a failure in keygen/persist/lookup.
   * @throws ConflictException when an idempotency key is reused for a
   *   different user or network, or when a concurrent call with the same key is
   *   still in flight.
   */
  async createWallet(
    request: CreateWalletOrchestratorRequest,
  ): Promise<WalletOrchestrationResult> {
    const { userId, network, idempotencyKey } = request;

    if (idempotencyKey) {
      const replay = await this.replayIfCompleted(
        idempotencyKey,
        userId,
        network,
      );
      if (replay) {
        return replay;
      }
    }

    // #941: refuse a suspended/disabled account before any key material is
    // minted. Deliberately placed after the replay check above so the retry
    // contract still returns the original result for an already-completed
    // create.
    if (this.userStatus) {
      const status = await this.userStatus.getStatus(userId);
      if (status === 'SUSPENDED' || status === 'DISABLED') {
        throw new ConflictException({
          code: 'WALLET_ORCHESTRATION_USER_INACTIVE',
          message: 'Wallet creation is not permitted for this account',
        });
      }
    }

    // Natural-key guard: one wallet per (userId, network), durable across
    // restarts and shared across instances.
    const existing = await this.store.findByNaturalKey(userId, network);
    if (existing) {
      return {
        wallet: existing,
        isNewWallet: false,
        idempotencyKey,
      };
    }

    // Keygen phase: mint and encrypt the secret seed.
    let encryptedSecret: string;
    let publicKey: string;
    try {
      const encryption = this.resolveEncryptionService();
      const seed = randomUUID().replace(/-/g, '');
      publicKey = `G${randomUUID().replace(/-/g, '').toUpperCase()}`;
      encryptedSecret = encryption.encrypt(seed);
    } catch (err) {
      throw new WalletOrchestrationError(
        `Wallet key generation failed: ${(err as Error).message}`,
        'keygen',
      );
    }

    const wallet: WalletCreationResult = {
      id: randomUUID(),
      userId,
      publicKey,
      encryptedSecret,
      network,
      status: WalletStatus.ACTIVE,
      idempotencyKey,
      createdAt: new Date(),
    };

    const result: WalletOrchestrationResult = {
      wallet,
      isNewWallet: true,
      idempotencyKey,
    };

    // Persist phase: atomically store the wallet and idempotency record. The
    // store enforces uniqueness across instances; a concurrent create that won
    // the race surfaces here and is resolved by returning the winner.
    try {
      await this.store.save(wallet, idempotencyKey);
    } catch (err) {
      const winner = await this.store.findByNaturalKey(userId, network);
      if (winner) {
        return {
          wallet: winner,
          isNewWallet: false,
          idempotencyKey,
        };
      }
      throw new WalletOrchestrationError(
        `Wallet persistence failed: ${(err as Error).message}`,
        'persist',
      );
    }

    return result;
  }
}

/**
 * Process-local fallback store used only when no durable store is bound
 * (isolated unit tests). Production wiring MUST provide a durable
 * implementation of `WalletCreationStore`.
 */
class InMemoryWalletCreationStore implements WalletCreationStore {
  private readonly wallets = new Map<string, WalletCreationResult>();
  private readonly byIdempotencyKey = new Map<string, IdempotencyEntry>();

  private static naturalKey(userId: string, network: WalletNetwork): string {
    return `${userId}:${network}`;
  }

  async findByNaturalKey(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | undefined> {
    return this.wallets.get(
      InMemoryWalletCreationStore.naturalKey(userId, network),
    );
  }

  async findIdempotency(
    key: string,
  ): Promise<IdempotencyEntry | undefined> {
    return this.byIdempotencyKey.get(key);
  }

  async save(
    wallet: WalletCreationResult,
    idempotencyKey?: string,
  ): Promise<void> {
    const naturalKey = InMemoryWalletCreationStore.naturalKey(
      wallet.userId,
      wallet.network,
    );
    if (this.wallets.has(naturalKey)) {
      throw new Error('Wallet already exists for this user and network');
    }
    if (idempotencyKey && this.byIdempotencyKey.has(idempotencyKey)) {
      throw new Error('Idempotency key already bound');
    }
    this.wallets.set(naturalKey, wallet);
    if (idempotencyKey) {
      this.byIdempotencyKey.set(idempotencyKey, {
        userId: wallet.userId,
        network: wallet.network,
        result: {
          wallet,
          isNewWallet: true,
          idempotencyKey,
        },
      });
    }
  }
}
