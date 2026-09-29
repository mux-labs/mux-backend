import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import {
  resolveSponsorshipLimits,
  WalletSponsorshipLimiter,
  WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV,
  WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV,
  WALLET_SPONSORSHIP_ENABLED_ENV,
  WALLET_SPONSORSHIP_WINDOW_MS_ENV,
  type WalletSponsorshipLimits,
} from './wallet-sponsorship-limits';

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
}

/**
 * The wallet representation this service returns.
 *
 * Deliberately carries **no key material at all** — not the seed, and not even
 * the AES-256-GCM envelope that is persisted for it. The custody secret must
 * not cross this service boundary (#963 custody invariant), so there is no
 * field here for a caller, a log line, or a response interceptor to leak: the
 * sealed envelope travels only as far as
 * {@link WalletOrchestrationStore.createWallet}.
 */
export interface WalletCreationResult {
  id: string;
  userId: string;
  publicKey: string;
  network: WalletNetwork;
  status: WalletStatus;
  idempotencyKey?: string;
  createdAt: Date;
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

/** A completed orchestration, keyed by the idempotency key that produced it. */
interface IdempotencyEntry {
  userId: string;
  network: WalletNetwork;
  result: WalletOrchestrationResult;
}

/** The orchestration phase that failed. */
export type WalletOrchestrationPhase = 'keygen' | 'persist' | 'lookup';

/** Typed failure so a caller can distinguish which orchestration phase failed. */
export class WalletOrchestrationError extends Error {
  constructor(
    message: string,
    readonly phase: WalletOrchestrationPhase,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WalletOrchestrationError';
  }
}

/**
 * Key material produced for a new wallet.
 *
 * `encryptedSecret` is the ONLY representation of the seed that may leave this
 * file: {@link OrchestrationKeyGenerator} hands over a keypair, the seed is
 * sealed with the custody cipher, and only the envelope travels on.
 */
export interface GeneratedKeyMaterial {
  /** Chain-agnostic public identifier (the Stellar address). */
  publicKey: string;
  /** Plaintext seed, when the generator issues one for this service to seal. */
  privateKey?: string;
  /** Already-sealed envelope, when the generator seals the seed itself. */
  encryptedData?: string;
  /** Envelope format/algorithm version, defaulting to 1. */
  encryptionVersion?: number;
}

/**
 * Key material in the shape a store consumes: the address plus its sealed
 * envelope. Derived from {@link GeneratedKeyMaterial}, which is what a key
 * service hands back.
 */
interface SealedKeyMaterial {
  /** Chain-agnostic public identifier (the Stellar address). */
  publicKey: string;
  /** Sealed seed envelope, or absent when no key service is wired. */
  encryptedSecret?: string;
  /** Envelope format/algorithm version. */
  encryptionVersion?: number;
}

/**
 * Keypair generation surface.
 *
 * Structural rather than a concrete class so the orchestrator stays testable
 * without a key service, and so a change in key management cannot silently
 * change this service's contract.
 */
export interface OrchestrationKeyGenerator {
  generateKey(): Promise<GeneratedKeyMaterial>;
}

/** Custody sealing surface, satisfied by `EncryptionService`. */
export interface OrchestrationCipher {
  encryptAndSerialize(plaintext: string): string;
}

/**
 * Optional user directory used for the create preflight.
 *
 * The lookup is optional because the wallet domain's owner reference is a
 * `User` id, while the user service's public lookup is by auth id today. When
 * no directory is wired, persistence remains the fail-closed backstop: the
 * `Wallet.userId` foreign key rejects an unbacked id.
 */
export interface OrchestrationUserDirectory {
  findUserById?(userId: string): Promise<{ id: string } | null>;
}

/** Input for {@link WalletOrchestrationStore.createWallet}. */
export interface NewWalletRecord {
  userId: string;
  network: WalletNetwork;
  publicKey: string;
  /**
   * Sealed seed envelope. Stores that durably persist key material must refuse
   * a record without one rather than write a placeholder.
   */
  encryptedSecret?: string;
  /** Envelope format/algorithm version. */
  encryptionVersion?: number;
}

/**
 * Persistence seam for wallet creation.
 *
 * The orchestrator owns two pieces of state: the wallet per
 * `(userId, network)` and the completed orchestration per idempotency key.
 * {@link InMemoryOrchestrationStore} keeps both in process, which is the
 * behaviour this service has always had (#963) and what keeps the service
 * constructible without a database. {@link PrismaOrchestrationStore} writes
 * them to Postgres (`Wallet` and `IdempotencyRecord`) when a client is
 * injected.
 */
export interface WalletOrchestrationStore {
  /** The existing wallet for `(userId, network)`, or null. */
  findExistingWallet(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | null>;
  /** Persists a newly minted wallet. */
  createWallet(record: NewWalletRecord): Promise<WalletCreationResult>;
  /**
   * The result a completed idempotency key replays, or null when the key is
   * unknown. Throws a conflict when the key belongs to another user/network.
   */
  replayCompleted(
    idempotencyKey: string,
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletOrchestrationResult | null>;
  /** Records a completed orchestration against its idempotency key. */
  rememberCompleted(
    idempotencyKey: string | undefined,
    userId: string,
    network: WalletNetwork,
    result: WalletOrchestrationResult,
  ): Promise<void>;
}

/** How long a completed orchestration stays replayable. */
export const ORCHESTRATION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Namespace a key by the request it belongs to, so reuse is detectable. */
function requestScope(userId: string, network: WalletNetwork): string {
  return `wallets/orchestration/create:${userId}:${network}`;
}

/**
 * In-process store: the orchestrator's default, and the one used by unit tests.
 *
 * It keeps the exact result object it is given, so a replay returns the
 * original `createdAt` rather than a re-derived one — a retry must observe the
 * first call's answer verbatim.
 */
export class InMemoryOrchestrationStore implements WalletOrchestrationStore {
  private readonly wallets = new Map<string, WalletCreationResult>();
  private readonly completed = new Map<string, IdempotencyEntry>();

  findExistingWallet(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | null> {
    return Promise.resolve(
      this.wallets.get(requestScope(userId, network)) ?? null,
    );
  }

  createWallet(record: NewWalletRecord): Promise<WalletCreationResult> {
    const wallet: WalletCreationResult = {
      id: randomUUID(),
      userId: record.userId,
      publicKey: record.publicKey,
      network: record.network,
      status: WalletStatus.ACTIVE,
      createdAt: new Date(),
    };
    this.wallets.set(requestScope(record.userId, record.network), wallet);
    return Promise.resolve(wallet);
  }

  replayCompleted(
    idempotencyKey: string,
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletOrchestrationResult | null> {
    const entry = this.completed.get(idempotencyKey);
    if (!entry) {
      return Promise.resolve(null);
    }
    if (entry.userId !== userId || entry.network !== network) {
      return Promise.reject(
        new ConflictException({
          code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT',
          message:
            'This idempotency key was already used for a different user or network',
        }),
      );
    }
    // Replay verbatim: same wallet id, same isNewWallet, same createdAt.
    return Promise.resolve(entry.result);
  }

  rememberCompleted(
    idempotencyKey: string | undefined,
    userId: string,
    network: WalletNetwork,
    result: WalletOrchestrationResult,
  ): Promise<void> {
    if (idempotencyKey) {
      this.completed.set(idempotencyKey, { userId, network, result });
    }
    return Promise.resolve();
  }
}

/**
 * A `Wallet` row as read back from the database.
 *
 * `network`/`status` are widened to `string` because the Prisma enums are
 * generated; the values are narrowed back to the domain enums on the way out.
 */
interface WalletRow {
  id: string;
  userId: string;
  publicKey: string;
  network: WalletNetwork | string;
  status: WalletStatus | string;
  createdAt: Date;
}

/** An `IdempotencyRecord` row, narrowed to the columns this service uses. */
interface IdempotencyRow {
  key: string;
  endpoint?: string | null;
  response?: unknown;
}

/** The transaction surface this store needs. */
interface OrchestrationTransaction {
  wallet: {
    findFirst(args: {
      where: { userId: string; network: string };
    }): Promise<WalletRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<WalletRow>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<WalletRow>;
  };
  idempotencyRecord: {
    findUnique(args: {
      where: { key: string };
    }): Promise<IdempotencyRow | null>;
    upsert(args: {
      where: { key: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * The slice of `PrismaClient`/`PrismaService` this store uses.
 *
 * Everything runs inside `$transaction`, so a single client instance is enough
 * and a wallet plus its idempotency record commit together.
 */
export interface OrchestrationDbClient {
  $transaction<T>(
    fn: (transaction: OrchestrationTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Narrows a persisted row to the projection this service returns. */
function toWallet(row: WalletRow): WalletCreationResult {
  return {
    id: row.id,
    userId: row.userId,
    publicKey: row.publicKey,
    network: row.network as WalletNetwork,
    status: row.status as WalletStatus,
    createdAt: row.createdAt,
  };
}

/**
 * Rebuilds a stored result.
 *
 * The envelope round-trips through a JSON column, so `createdAt` comes back as
 * an ISO string; a replay must still hand the caller a `Date`.
 */
function reviveResult(raw: unknown): WalletOrchestrationResult | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const envelope = raw as {
    wallet?: {
      id?: unknown;
      userId?: unknown;
      publicKey?: unknown;
      network?: unknown;
      status?: unknown;
      createdAt?: unknown;
    };
    isNewWallet?: unknown;
    idempotencyKey?: unknown;
  };
  const wallet = envelope.wallet;
  if (!wallet || typeof wallet.id !== 'string') {
    return null;
  }
  const createdAt = wallet.createdAt;
  const idempotencyKey =
    typeof envelope.idempotencyKey === 'string'
      ? envelope.idempotencyKey
      : undefined;

  return {
    wallet: {
      id: wallet.id,
      userId: typeof wallet.userId === 'string' ? wallet.userId : '',
      publicKey: typeof wallet.publicKey === 'string' ? wallet.publicKey : '',
      network: (typeof wallet.network === 'string'
        ? wallet.network
        : WalletNetwork.TESTNET) as WalletNetwork,
      status: (typeof wallet.status === 'string'
        ? wallet.status
        : WalletStatus.ACTIVE) as WalletStatus,
      createdAt:
        createdAt instanceof Date
          ? createdAt
          : typeof createdAt === 'string' || typeof createdAt === 'number'
            ? new Date(createdAt)
            : new Date(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    isNewWallet: envelope.isNewWallet === true,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/**
 * Database-backed store, used when a client is injected.
 *
 * Wallets are written as `PROVISIONING` and flipped to `ACTIVE` in the same
 * transaction, so a wallet is never visible as half-created. A wallet without
 * a sealed envelope is refused outright: the column is `NOT NULL` and a
 * placeholder would be worse than a failed request.
 */
export class PrismaOrchestrationStore implements WalletOrchestrationStore {
  constructor(private readonly client: OrchestrationDbClient) {}

  findExistingWallet(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | null> {
    return this.client.$transaction(async (transaction) => {
      const row = await transaction.wallet.findFirst({
        where: { userId, network },
      });
      return row ? toWallet(row) : null;
    });
  }

  createWallet(record: NewWalletRecord): Promise<WalletCreationResult> {
    if (!record.encryptedSecret) {
      return Promise.reject(
        new Error('Refusing to persist a wallet without sealed key material'),
      );
    }
    return this.client.$transaction(async (transaction) => {
      const created = await transaction.wallet.create({
        data: {
          userId: record.userId,
          network: record.network,
          publicKey: record.publicKey,
          encryptedSecret: record.encryptedSecret,
          encryptionVersion: record.encryptionVersion ?? 1,
          status: 'PROVISIONING',
        },
      });
      const active = await transaction.wallet.update({
        where: { id: created.id },
        data: { status: 'ACTIVE' },
      });
      return toWallet(active);
    });
  }

  replayCompleted(
    idempotencyKey: string,
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletOrchestrationResult | null> {
    return this.client.$transaction(async (transaction) => {
      const row = await transaction.idempotencyRecord.findUnique({
        where: { key: idempotencyKey },
      });
      if (!row) {
        return null;
      }
      if (row.endpoint && row.endpoint !== requestScope(userId, network)) {
        throw new ConflictException({
          code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT',
          message:
            'This idempotency key was already used for a different user or network',
        });
      }
      return reviveResult(row.response);
    });
  }

  rememberCompleted(
    idempotencyKey: string | undefined,
    userId: string,
    network: WalletNetwork,
    result: WalletOrchestrationResult,
  ): Promise<void> {
    if (!idempotencyKey) {
      return Promise.resolve();
    }
    const response = result as unknown as Record<string, unknown>;
    return this.client
      .$transaction(async (transaction) => {
        await transaction.idempotencyRecord.upsert({
          where: { key: idempotencyKey },
          create: {
            key: idempotencyKey,
            method: 'POST',
            endpoint: requestScope(userId, network),
            response,
            statusCode: HttpStatus.OK,
            expiresAt: new Date(Date.now() + ORCHESTRATION_IDEMPOTENCY_TTL_MS),
          },
          update: { response },
        });
      })
      .then(() => undefined);
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
 * Custody invariant: the seed is sealed with the custody cipher before it
 * reaches a store, and the result carries no key material at all — see
 * {@link WalletCreationResult}.
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
 * ## Sponsored-wallet cap (#957)
 *
 * Wallet creation spends sponsor resource: the base-reserve XLM the sponsor
 * fronts for a new account, plus the transaction fee. Nothing else bounds how
 * much of it one caller can consume, so the gate below is what stops a single
 * actor looping create requests from draining the sponsor account — an
 * availability incident on the money path, not a nuisance error.
 *
 * Its position in `createWallet` is load-bearing:
 *
 *  - **After** the replay and existing-wallet checks, so a retry or a
 *    get-or-create spends nothing. Charging those would let a retried request
 *    exhaust a caller's allowance without creating anything.
 *  - **Before** key generation and persistence, so a refused request spends no
 *    sponsor resource and mints no wallet.
 *
 * `WalletSponsorshipLimiter.assertWithinLimits` checks and consumes in one
 * step, so two concurrent callers cannot both observe "one slot left" and both
 * take it, and a refusal surfaces as a 429 with a stable
 * `WALLET_SPONSORSHIP_*` code rather than a 500.
 */
@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);

  /** Idempotency keys currently being processed (guard 2). */
  private readonly inFlight = new Set<string>();

  /** Where wallets and completed orchestrations live. */
  private readonly store: WalletOrchestrationStore;

  /**
   * Caps how much sponsor resource wallet creation may consume (#957).
   *
   * Created here rather than injected so the cap is always present: an
   * optional dependency would silently disable the control if a module wiring
   * change ever dropped it. The limits come from configuration, never from the
   * caller.
   */
  private readonly sponsorshipLimiter: WalletSponsorshipLimiter;

  constructor(
    @Optional() private readonly cipher?: OrchestrationCipher,
    @Optional() private readonly configService?: ConfigService,
    /**
     * Optional user directory, taken untyped: the by-id lookup is probed at
     * runtime so that a directory which does not implement it — including
     * `IdempotentUserService`, which only looks users up by auth id — stays a
     * valid provider instead of a compile error at the injection point.
     */
    @Optional() private readonly userDirectory?: unknown,
    @Optional() private readonly keyGenerator?: OrchestrationKeyGenerator,
    @Optional() db?: OrchestrationDbClient,
  ) {
    // A database client is wrapped in the store that speaks to it; without one
    // the orchestrator keeps its wallet and idempotency state in process, which
    // is the behaviour this service has always had (#963).
    this.store = db
      ? new PrismaOrchestrationStore(db)
      : new InMemoryOrchestrationStore();
    this.sponsorshipLimiter = new WalletSponsorshipLimiter(
      this.readSponsorshipLimits(),
    );
  }

  /**
   * Creates a wallet for `userId` on `network`, or returns the existing one.
   *
   * @param request User, network, and optional idempotency key.
   * @returns The wallet plus whether this call created it.
   * @throws WalletOrchestrationError on a failure in keygen/persist/lookup.
   * @throws HttpException with a `WALLET_SPONSORSHIP_*` code (429) when the
   *   sponsored-wallet cap refuses the request.
   * @throws ConflictException when an idempotency key is reused for a
   *   different user or network, or a concurrent call still holds it.
   */
  async createWallet(
    request: CreateWalletOrchestratorRequest,
  ): Promise<WalletOrchestrationResult> {
    const { userId, network, idempotencyKey } = request;

    if (idempotencyKey) {
      // Guard 1. Checked before anything else, and before an allowance is
      // spent: a replayed request is a retry, not a new sponsored creation.
      const replay = await this.store.replayCompleted(
        idempotencyKey,
        userId,
        network,
      );
      if (replay) {
        return replay;
      }
      if (this.inFlight.has(idempotencyKey)) {
        // Guard 2. Fail closed with a stable, retryable conflict rather than
        // minting a second wallet for the same logical request.
        throw new ConflictException({
          code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_IN_PROGRESS',
          message:
            'A wallet creation with this idempotency key is already in progress',
        });
      }
      this.inFlight.add(idempotencyKey);
    }

    try {
      // Guard 3. Also before the cap: a get-or-create returns the existing
      // wallet and must not cost the caller an allowance slot.
      const existing = await this.store.findExistingWallet(userId, network);
      if (existing) {
        return await this.record(
          idempotencyKey,
          userId,
          network,
          existing,
          false,
        );
      }

      await this.assertUserExists(userId);

      // The sponsored work starts here (#957). `assertWithinLimits` throws on
      // refusal, before any key material is generated or persisted.
      this.sponsorshipLimiter.assertWithinLimits(userId);

      const wallet = await this.mint(userId, network);
      return await this.record(idempotencyKey, userId, network, wallet, true);
    } catch (error) {
      throw this.fail(userId, network, error);
    } finally {
      if (idempotencyKey) {
        this.inFlight.delete(idempotencyKey);
      }
    }
  }

  /** Records and returns the outcome of a call that reached a wallet. */
  private async record(
    idempotencyKey: string | undefined,
    userId: string,
    network: WalletNetwork,
    wallet: WalletCreationResult,
    isNewWallet: boolean,
  ): Promise<WalletOrchestrationResult> {
    const result: WalletOrchestrationResult = {
      wallet: idempotencyKey ? { ...wallet, idempotencyKey } : wallet,
      isNewWallet,
      idempotencyKey,
    };
    await this.store.rememberCompleted(idempotencyKey, userId, network, result);
    return result;
  }

  /**
   * Generates key material and persists the wallet.
   *
   * Split out so a failure can name the phase it happened in, and so the whole
   * step stays inside the in-flight reservation (`createWallet` awaits it).
   */
  private async mint(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult> {
    let material: SealedKeyMaterial;
    try {
      material = await this.generateKeyMaterial();
    } catch (error) {
      if (error instanceof WalletOrchestrationError) {
        throw error;
      }
      throw new WalletOrchestrationError(
        'Key generation failed',
        'keygen',
        error,
      );
    }

    try {
      return await this.store.createWallet({
        userId,
        network,
        publicKey: material.publicKey,
        encryptedSecret: material.encryptedSecret,
        encryptionVersion: material.encryptionVersion,
      });
    } catch (error) {
      throw new WalletOrchestrationError(
        'Wallet persistence failed',
        'persist',
        error,
      );
    }
  }

  /**
   * Produces the address plus a sealed envelope for its seed.
   *
   * Two directions are supported because key services differ: a generator may
   * hand back an already-sealed envelope, or a plaintext key for this service
   * to seal. Neither wired means the in-process store is in use, and that store
   * keeps no key material at all.
   */
  private async generateKeyMaterial(): Promise<SealedKeyMaterial> {
    if (!this.keyGenerator) {
      // The address still comes from the CSPRNG; there is nothing to seal
      // because nothing durable is written.
      return { publicKey: `G${randomUUID().replace(/-/g, '').slice(0, 55)}` };
    }

    const key = await this.keyGenerator.generateKey();
    if (key.encryptedData) {
      return {
        publicKey: key.publicKey,
        encryptedSecret: key.encryptedData,
        encryptionVersion: key.encryptionVersion ?? 1,
      };
    }

    if (!this.cipher || !key.privateKey) {
      // Fail closed: a wallet must never be persisted with an unsealed seed.
      throw new WalletOrchestrationError(
        'Key material could not be sealed for custody',
        'keygen',
      );
    }

    return {
      publicKey: key.publicKey,
      encryptedSecret: this.cipher.encryptAndSerialize(key.privateKey),
      encryptionVersion: key.encryptionVersion ?? 1,
    };
  }

  /**
   * Fails closed when the directory knows there is no user behind `userId`.
   *
   * `Wallet.userId` is a foreign key, so minting for an unbacked id fails at
   * persist time — after an allowance slot has already been consumed. The
   * preflight moves that failure ahead of the sponsored work. When no directory
   * is wired the check is skipped, and persistence remains the fail-closed
   * backstop.
   */
  private async assertUserExists(userId: string): Promise<void> {
    const directory = this.userDirectory as
      OrchestrationUserDirectory | undefined;
    if (!directory || typeof directory.findUserById !== 'function') {
      return;
    }
    const user = await directory.findUserById(userId);
    if (!user) {
      throw new NotFoundException({
        code: 'WALLET_ORCHESTRATION_USER_NOT_FOUND',
        message: `No user ${userId} to create a wallet for`,
      });
    }
  }

  /**
   * Maps a failure from the create path onto the status the caller must see.
   *
   * Order matters: a sponsorship refusal is a *policy* answer, so it becomes a
   * 429 with its stable code. Everything that already carries an HTTP status
   * (conflicts, missing users, dependency outages) is passed through
   * unchanged; anything else is an orchestration fault.
   */
  private fail(userId: string, network: WalletNetwork, error: unknown): Error {
    const phase =
      error instanceof WalletOrchestrationError ? error.phase : undefined;
    this.logger.error(
      `Wallet creation orchestration failed for user ${userId} on ${network}` +
        (phase ? ` (phase: ${phase})` : ''),
      error instanceof Error ? error.stack : String(error),
    );

    // @nestjs/common exposes no TooManyRequestsException, so the 429 is raised
    // through HttpException + HttpStatus.TOO_MANY_REQUESTS. Masking it as a 500
    // would tell the caller to retry immediately instead of backing off until
    // the window rolls.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.startsWith('WALLET_SPONSORSHIP_')) {
      throw new HttpException(
        {
          code,
          message: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      error instanceof HttpException ||
      error instanceof WalletOrchestrationError
    ) {
      return error;
    }

    return new WalletOrchestrationError(
      'Wallet creation orchestration failed',
      'persist',
      error,
    );
  }

  /**
   * Returns the existing wallet for a user+network, or null.
   *
   * A read: it never spends sponsored-wallet allowance.
   */
  async getWalletByUser(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | null> {
    try {
      return await this.store.findExistingWallet(userId, network);
    } catch (error) {
      throw new WalletOrchestrationError(
        'Wallet lookup failed',
        'lookup',
        error,
      );
    }
  }

  /**
   * Whether `userId` has no wallet yet on `network`, i.e. whether a create
   * call would mint a new wallet rather than return an existing one.
   */
  async validateUserCanCreateWallet(
    userId: string,
    network: WalletNetwork,
  ): Promise<boolean> {
    return (await this.getWalletByUser(userId, network)) === null;
  }

  /**
   * Reads the sponsored-wallet caps (#957).
   *
   * `WalletSponsorshipLimiter` validates and defaults every value, so a typo,
   * an empty string, or a negative can only narrow the allowance — never widen
   * it — and unset means "default caps", never "no caps". Configuration is read
   * through `ConfigService` when it is wired, so the caps come from the app's
   * configuration rather than an ad-hoc `process.env` read at the call site.
   */
  private readSponsorshipLimits(): WalletSponsorshipLimits {
    const config = this.configService;
    if (!config) {
      return resolveSponsorshipLimits();
    }
    const read = (key: string): string | undefined => config.get<string>(key);
    return resolveSponsorshipLimits({
      [WALLET_SPONSORSHIP_ENABLED_ENV]: read(WALLET_SPONSORSHIP_ENABLED_ENV),
      [WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV]: read(
        WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV,
      ),
      [WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV]: read(
        WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV,
      ),
      [WALLET_SPONSORSHIP_WINDOW_MS_ENV]: read(
        WALLET_SPONSORSHIP_WINDOW_MS_ENV,
      ),
    });
  }
}
