import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  CURRENT_KEY_VERSION,
  KeyRotationErrorCode,
  KEY_ROTATION_ENABLED_ENV,
  ROTATION_REPLAY_WINDOW_MS,
  SUPPORTED_KEY_VERSIONS,
} from './key-rotation.model';
import type {
  KeyRotationActor,
  KeyRotationResult,
  WalletKeyMetadata,
} from './key-rotation.model';

/** DI token for {@link WalletKeyStore}. */
export const WALLET_KEY_STORE = 'WALLET_KEY_STORE';

/**
 * DI token for {@link KeyEnvelopeProvider}.
 *
 * Deliberately **not** registered in `WalletsModule`. The real implementation
 * belongs to the custody/HSM layer (`src/key-management`), which owns
 * `WALLET_ENCRYPTION_KEY` and the derivation scheme. This module does not
 * implement re-encryption itself: a rotation path able to construct key
 * material in the request path would be a custody regression, not a feature.
 *
 * Until a deployment binds the token, `KeyRotationService` still constructs
 * (so reads and the feature-flag gate keep working) but every rotation is
 * refused with `KEY_ROTATION_DEPENDENCY_UNAVAILABLE` — fail-closed by absence,
 * rather than fail-open with a stub that silently "succeeds" and loses a
 * wallet's key.
 */
export const KEY_ENVELOPE_PROVIDER = 'KEY_ENVELOPE_PROVIDER';

/**
 * The subset of a `Wallet` row this service reads and writes.
 *
 * There is deliberately no plaintext key field: `encryptedSecret` is passed
 * through opaquely and is never logged, returned, or inspected.
 */
export interface WalletKeyRecord {
  id: string;
  userId: string;
  keyVersion: number;
  encryptionVersion: number;
  secretVersion: number;
  network: string;
  /** Opaque envelope. Handled by the crypto provider; never inspected here. */
  encryptedSecret: string;
  updatedAt?: Date;
}

/**
 * A persisted record of a completed rotation, keyed by idempotency key.
 *
 * Stored in the shared {@link WalletKeyStore} so a replay that lands on a
 * different instance still returns the original result. `expiresAt` bounds
 * how long a replay is honoured; expired rows are pruned on write.
 */
export interface KeyRotationReplayRecord {
  idempotencyKey: string;
  walletId: string;
  targetKeyVersion: number;
  result: KeyRotationResult;
  expiresAt: Date;
}

/**
 * Narrow persistence port for key rotation.
 *
 * Declared structurally so the service is unit-testable without Prisma, and so
 * the module stays honest about the small surface it touches. `PrismaService`
 * satisfies it structurally.
 */
export interface WalletKeyStore {
  wallet: {
    findUnique(args: {
      where: { id: string };
    }): Promise<WalletKeyRecord | null>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<WalletKeyRecord>;
  };
  /**
   * Shared, cross-instance store for completed rotations. Optional so existing
   * stores that only implement `wallet` keep compiling; when absent the
   * service falls back to a process-local map (single-instance behaviour).
   */
  keyRotationReplay?: {
    findUnique(args: {
      where: { idempotencyKey: string };
    }): Promise<KeyRotationReplayRecord | null>;
    upsert(args: {
      where: { idempotencyKey: string };
      create: KeyRotationReplayRecord;
      update: KeyRotationReplayRecord;
    }): Promise<KeyRotationReplayRecord>;
    deleteMany(args: {
      where: { expiresAt: { lt: Date } };
    }): Promise<{ count: number }>;
  };
}

/**
 * Crypto provider port.
 *
 * Rotation is expressed as "re-encrypt the same secret under the new
 * derivation scheme", so the service never sees plaintext key material. The
 * provider is also responsible for refusing an envelope it cannot decrypt.
 */
export interface KeyEnvelopeProvider {
  /**
   * Returns a new envelope holding the same secret, re-derived under
   * `toKeyVersion`.
   *
   * MUST throw when the existing envelope cannot be decrypted, and must never
   * fall back to a previous version or to plaintext.
   */
  reEncrypt(params: {
    encryptedSecret: string;
    fromKeyVersion: number;
    toKeyVersion: number;
  }): Promise<{ encryptedSecret: string; encryptionVersion: number }>;
}

/**
 * Wallet `keyVersion` rotation.
 *
 * `keyVersion` tracks the key algorithm/derivation scheme, distinct from
 * `encryptionVersion` (the envelope format) and `secretVersion` (a counter
 * bumped on every secret rotation). Rotating moves a wallet onto a newer
 * derivation scheme without changing the account it controls.
 *
 * Invariants:
 *
 * 1. **Server is the source of truth.** The current version is read from the
 *    store; a caller-supplied version is never used to decide what to write.
 * 2. **Fail-closed decrypt.** If the envelope cannot be decrypted, or the
 *    wallet's `keyVersion` is outside {@link SUPPORTED_KEY_VERSIONS}, the
 *    rotation is refused. It never falls back to plaintext, to an older key, or
 *    to "assume it is the latest version".
 * 3. **Monotonicity.** `keyVersion` only increases. Rotating to the same or an
 *    older version is rejected, so a replayed or out-of-order request can never
 *    downgrade a wallet's key scheme.
 * 4. **Idempotent.** Replaying a rotation returns the original result and does
 *    not re-encrypt. Reusing an idempotency key with a different target version
 *    is an explicit conflict, not a silent re-run.
 * 5. **Authorization is deny-by-default.** Rotation requires owner or guardian.
 *    A delegate may read metadata but cannot rotate.
 * 6. **Kill-switch.** `KEY_ROTATION_ENABLED` defaults to off; reads work
 *    unflagged, every rotation is refused until an operator opts in.
 * 7. **No key material in logs, metrics, or responses.** Only version numbers,
 *    wallet ids and correlation ids are emitted.
 */
@Injectable()
export class KeyRotationService {
  private readonly logger = new Logger(KeyRotationService.name);

  /**
   * Process-local fallback for completed rotations keyed by idempotency key.
   * Only used when the store does not expose a shared `keyRotationReplay`
   * table; otherwise replays are read from and written to the shared store so
   * they are visible across instances.
   */
  private readonly rotationLog = new Map<string, KeyRotationResult>();

  constructor(
    @Inject(WALLET_KEY_STORE)
    private readonly store: WalletKeyStore,
    /**
     * Optional by design: the envelope provider belongs to the custody/HSM
     * layer and may be unbound. Making it optional lets the module *boot* (so
     * reads and the kill-switch gate work) while the rotate path still refuses
     * to run without it — see the guard in `rotate`.
     *
     * Declared as `| undefined` (rather than `?`) purely so a required
     * parameter can follow it; `@Optional()` is what makes DI treat it as
     * optional at runtime.
     */
    @Optional()
    @Inject(KEY_ENVELOPE_PROVIDER)
    private readonly envelopes: KeyEnvelopeProvider | undefined,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Whether rotation is enabled. Fail-closed: only an explicit `true`/`1`
   * enables it. Any other value — including a typo — leaves rotation off.
   */
  isKeyRotationEnabled(): boolean {
    const raw = process.env[KEY_ROTATION_ENABLED_ENV];
    return raw === 'true' || raw === '1';
  }

  /**
   * Read a wallet's key metadata. Requires owner/delegate/guardian/API-key.
   *
   * Returns versions only. There is deliberately no field through which key
   * material could reach the caller.
   */
  async getKeyMetadata(
    walletId: string,
    actor: KeyRotationActor,
  ): Promise<WalletKeyMetadata> {
    this.assertValidWalletId(walletId);
    const wallet = await this.requireWallet(walletId, 'key.metadata');
    this.assertReadAuthorized(wallet, actor);

    return {
      walletId,
      keyVersion: wallet.keyVersion,
      encryptionVersion: wallet.encryptionVersion,
      secretVersion: wallet.secretVersion,
      network: wallet.network,
      supported: SUPPORTED_KEY_VERSIONS.includes(wallet.keyVersion),
      upToDate: wallet.keyVersion === CURRENT_KEY_VERSION,
    };
  }

  /**
   * Rotate a wallet onto `targetKeyVersion`.
   *
   * Fails closed at every step: an unreadable envelope, an unknown stored
   * version, an unreachable store, or a disabled kill-switch all refuse the
   * rotation and leave the wallet exactly as it was.
   */
  async rotateKeyVersion(
    walletId: string,
    targetKeyVersion: number,
    actor: KeyRotationActor,
    idempotencyKey?: string,
  ): Promise<KeyRotationResult> {
    this.assertValidWalletId(walletId);
    this.assertValidVersion(targetKeyVersion);
    this.assertRotationEnabled();

    const wallet = await this.requireWallet(walletId, 'key.rotate');

    // Authz runs before anything further is inspected, so an unauthorized
    // caller learns nothing about the wallet beyond "it exists".
    this.assertRotationAuthorized(wallet, actor);

    // An idempotency key reused for a *different* target is a conflict, not a
    // silent re-run: the caller would otherwise believe a rotation happened
    // that did not. Checked against the shared store first so a replay that
    // lands on another instance is still detected.
    if (idempotencyKey) {
      const replay = await this.findReplay(idempotencyKey);
      if (replay) {
        if (replay.targetKeyVersion !== targetKeyVersion) {
          throw new ConflictException({
            code: KeyRotationErrorCode.IDEMPOTENCY_CONFLICT,
            message: 'Idempotency key reused for a different target version',
          });
        }
        return replay.result;
      }
    }

    // ... rest of the rotation path (unchanged) ...
    throw new ServiceUnavailableException({
      code: KeyRotationErrorCode.DEPENDENCY_UNAVAILABLE,
      message: 'Key rotation is not available',
    });
  }

  /**
   * Look up a completed rotation by idempotency key.
   *
   * Reads from the shared store when available so a replay that lands on a
   * different instance sees the original result; falls back to the
   * process-local map otherwise. Expired entries are treated as absent.
   */
  private async findReplay(
    idempotencyKey: string,
  ): Promise<{ targetKeyVersion: number; result: KeyRotationResult } | null> {
    const replayStore = this.store.keyRotationReplay;
    if (replayStore) {
      const record = await replayStore.findUnique({
        where: { idempotencyKey },
      });
      if (!record) {
        return null;
      }
      if (record.expiresAt.getTime() <= Date.now()) {
        return null;
      }
      return {
        targetKeyVersion: record.targetKeyVersion,
        result: record.result,
      };
    }

    const cached = this.rotationLog.get(idempotencyKey);
    if (!cached) {
      return null;
    }
    return { targetKeyVersion: cached.toKeyVersion, result: cached };
  }

  /**
   * Record a completed rotation so replays return the original result.
   *
   * Writes to the shared store when available (pruning expired rows on the
   * same write) so the record is visible to every instance; otherwise falls
   * back to the process-local map.
   */
  private async recordReplay(
    idempotencyKey: string,
    walletId: string,
    targetKeyVersion: number,
    result: KeyRotationResult,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + ROTATION_REPLAY_WINDOW_MS);
    const replayStore = this.store.keyRotationReplay;
    if (replayStore) {
      await replayStore.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const record: KeyRotationReplayRecord = {
        idempotencyKey,
        walletId,
        targetKeyVersion,
        result,
        expiresAt,
      };
      await replayStore.upsert({
        where: { idempotencyKey },
        create: record,
        update: record,
      });
      return;
    }

    this.pruneRotationLog();
    this.rotationLog.set(idempotencyKey, result);
  }

  /** Drop expired entries from the process-local fallback map. */
  private pruneRotationLog(): void {
    const now = Date.now();
    for (const [key, result] of this.rotationLog) {
      if (now - result.rotatedAt.getTime() >= ROTATION_REPLAY_WINDOW_MS) {
        this.rotationLog.delete(key);
      }
    }
  }

  // ... remaining helpers (assertValidWalletId, requireWallet, authz, etc.) unchanged ...
}
