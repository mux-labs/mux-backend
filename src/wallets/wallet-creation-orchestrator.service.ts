import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { randomUUID } from 'crypto';
import { EncryptionService } from '../encryption/encryption.service';

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

/** In-memory record of a completed orchestration, keyed by idempotency key. */
interface IdempotencyEntry {
  userId: string;
  network: WalletNetwork;
  result: WalletOrchestrationResult;
}

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
 */
@Injectable()
export class WalletCreationOrchestrator {
  private readonly logger = new Logger(WalletCreationOrchestrator.name);

  /** One wallet per (userId, network) — the natural-key guard. */
  private readonly wallets = new Map<string, WalletCreationResult>();
  private readonly byIdempotencyKey = new Map<string, IdempotencyEntry>();
  private readonly inFlight = new Set<string>();

  private static readonly naturalKey = (
    userId: string,
    network: WalletNetwork,
  ): string => `${userId}:${network}`;

  constructor(private readonly encryptionService: EncryptionService) {}

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
    userId: string,
    network: WalletNetwork,
    idempotencyKey: string,
  ): Promise<WalletCreationResult> {
    const publicKey = `G${randomUUID().slice(0, 55)}`;
    const secretSeed = `S${randomUUID().slice(0, 55)}`;

    // Encrypt before the secret can be persisted or returned. Throwing here
    // (e.g. missing WALLET_ENCRYPTION_KEY) aborts creation rather than falling
    // back to storing the seed in plaintext.
    const encryptedSecret =
      this.encryptionService.encryptAndSerialize(secretSeed);

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
      const replay = this.replayIfCompleted(idempotencyKey, userId, network);
      if (replay) {
        return replay;
      }
      if (this.inFlight.has(idempotencyKey)) {
        // A concurrent retry is still working. Fail closed with a stable,
        // retryable conflict rather than minting a second wallet.
        throw new ConflictException({
          code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_IN_PROGRESS',
          message:
            'A wallet creation with this idempotency key is already in progress',
        });
      }
      this.inFlight.add(idempotencyKey);
    }

    try {
      const existing = this.wallets.get(
        WalletCreationOrchestrator.naturalKey(userId, network),
      );

      if (existing) {
        // Guard 3: a retry without a key, or one whose key has since expired,
        // still cannot duplicate a wallet.
        const result: WalletOrchestrationResult = {
          wallet: existing,
          isNewWallet: false,
          idempotencyKey,
        };
        this.recordCompletion(idempotencyKey, userId, network, result);
        return result;
      }

      // Awaited so the in-flight reservation is held until the wallet is
      // actually persisted. Without the await, a concurrent retry would find
      // the reservation already released and could mint a second wallet.
      const wallet = await this.mint(userId, network, idempotencyKey);
      const result: WalletOrchestrationResult = {
        wallet,
        isNewWallet: true,
        idempotencyKey,
      };
      this.recordCompletion(idempotencyKey, userId, network, result);
      return result;
    } finally {
      if (idempotencyKey) {
        this.inFlight.delete(idempotencyKey);
      }
    }
  }

  /**
   * Returns the stored result for a completed key, or null when the key is
   * unknown. Throws when the key was used for a different user/network.
   */
  private replayIfCompleted(
    idempotencyKey: string,
    userId: string,
    network: WalletNetwork,
  ): WalletOrchestrationResult | null {
    const entry = this.byIdempotencyKey.get(idempotencyKey);
    if (!entry) {
      return null;
    }
    if (entry.userId !== userId || entry.network !== network) {
      throw new ConflictException({
        code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT',
        message:
          'This idempotency key was already used for a different user or network',
      });
    }
    // Replay verbatim: same wallet id, same isNewWallet, same createdAt.
    return entry.result;
  }

  private recordCompletion(
    idempotencyKey: string | undefined,
    userId: string,
    network: WalletNetwork,
    result: WalletOrchestrationResult,
  ): void {
    if (!idempotencyKey) {
      return;
    }
    this.byIdempotencyKey.set(idempotencyKey, { userId, network, result });
  }

  /**
   * Key generation + persistence. Split so failures can name their phase.
   *
   * Declared `async` because persistence is a database round-trip; the
   * in-memory store resolves synchronously today, but callers must still await
   * so the in-flight idempotency reservation is held for the real duration.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  private async mint(
    userId: string,
    network: WalletNetwork,
    idempotencyKey?: string,
  ): Promise<WalletCreationResult> {
    let publicKey: string;
    try {
      publicKey = `G${randomUUID().replace(/-/g, '').slice(0, 55)}`;
    } catch {
      throw new WalletOrchestrationError('Key generation failed', 'keygen');
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
      network,
      status: WalletStatus.ACTIVE,
      idempotencyKey,
      createdAt: new Date(),
    };

    try {
      this.wallets.set(
        WalletCreationOrchestrator.naturalKey(userId, network),
        wallet,
      );
    } catch {
      throw new WalletOrchestrationError(
        'Wallet persistence failed',
        'persist',
      );
    }

    return wallet;
  }

  /**
   * Returns the existing wallet for a user+network, or null.
   *
   * `async` for the same reason as `mint`: the read is a database round-trip in
   * production, and the public contract is promise-based.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getWalletByUser(
    userId: string,
    network: WalletNetwork,
  ): Promise<WalletCreationResult | null> {
    try {
      return (
        this.wallets.get(
          WalletCreationOrchestrator.naturalKey(userId, network),
        ) ?? null
      );
    } catch {
      throw new WalletOrchestrationError('Wallet lookup failed', 'lookup');
    }
  }

  /**
   * Whether `userId` has no wallet yet on `network`, i.e. whether a create
   * call would mint a new wallet rather than return an existing one.
   *
   * `async` to match the other public reads (a DB round-trip in production).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async validateUserCanCreateWallet(
    userId: string,
    network: WalletNetwork,
  ): Promise<boolean> {
    return !this.wallets.has(
      WalletCreationOrchestrator.naturalKey(userId, network),
    );
  }
}
