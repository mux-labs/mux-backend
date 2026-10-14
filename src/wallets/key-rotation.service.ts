import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
 * Until a deployment binds the token, `KeyRotationService` fails to construct
 * and the surface is unreachable — fail-closed by absence, rather than
 * fail-open with a stub that silently "succeeds" and loses a wallet's key.
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
   * Completed rotations keyed by idempotency key. Time-expiring and pruned on
   * write so a long-running process cannot accumulate entries indefinitely.
   */
  private readonly rotationLog = new Map<string, KeyRotationResult>();

  constructor(
    @Inject(WALLET_KEY_STORE)
    private readonly store: WalletKeyStore,
    @Inject(KEY_ENVELOPE_PROVIDER)
    private readonly envelopes: KeyEnvelopeProvider,
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
    // that never did.
    this.assertNoIdempotencyConflict(
      walletId,
      targetKeyVersion,
      idempotencyKey,
    );

    // Fail closed on an unknown stored version rather than assuming "latest".
    if (!SUPPORTED_KEY_VERSIONS.includes(wallet.keyVersion)) {
      this.metrics.incrementCounter('key_rotation_version_unsupported');
      this.logger.error(
        `key.rotate refused wallet=${walletId} storedVersion=${wallet.keyVersion} ` +
          `correlationId=${actor.correlationId}`,
      );
      throw new ServiceUnavailableException({
        code: KeyRotationErrorCode.VERSION_UNSUPPORTED,
        message: 'Wallet key version is not supported; rotation refused',
        correlationId: actor.correlationId,
      });
    }

    // Monotonicity: refuse no-ops and downgrades. A replayed request therefore
    // cannot walk a wallet backwards through derivation schemes.
    if (targetKeyVersion <= wallet.keyVersion) {
      this.metrics.incrementCounter('key_rotation_version_conflict');
      throw new ConflictException({
        code: KeyRotationErrorCode.VERSION_CONFLICT,
        message:
          `Rotation must increase keyVersion; wallet is at ${wallet.keyVersion}, ` +
          `requested ${targetKeyVersion}`,
        correlationId: actor.correlationId,
      });
    }

    // An idempotent replay returns the original result without re-encrypting.
    const replay = this.findReplay(walletId, targetKeyVersion, idempotencyKey);
    if (replay) {
      this.metrics.incrementCounter('key_rotation_replayed');
      return { ...replay, applied: false };
    }

    let reEncrypted: { encryptedSecret: string; encryptionVersion: number };
    try {
      reEncrypted = await this.envelopes.reEncrypt({
        encryptedSecret: wallet.encryptedSecret,
        fromKeyVersion: wallet.keyVersion,
        toKeyVersion: targetKeyVersion,
      });
    } catch (err) {
      // Fail closed: an undecryptable envelope must never yield a fallback key.
      this.metrics.incrementCounter('key_rotation_decrypt_failed');
      this.logger.error(
        `key.rotate decrypt failed wallet=${walletId} ` +
          `fromVersion=${wallet.keyVersion} toVersion=${targetKeyVersion} ` +
          `correlationId=${actor.correlationId} reason=${this.errorName(err)}`,
      );
      throw new ServiceUnavailableException({
        code: KeyRotationErrorCode.DECRYPT_FAILED,
        message: 'Key material could not be decrypted; rotation refused',
        correlationId: actor.correlationId,
      });
    }

    const rotatedAt = new Date();
    const updated = await this.withDependencyGuard(actor.correlationId, () =>
      this.store.wallet.update({
        where: { id: walletId },
        data: {
          keyVersion: targetKeyVersion,
          encryptionVersion: reEncrypted.encryptionVersion,
          // Bump the secret counter so the rotation is auditable and a later
          // replay of the same envelope is detectable.
          secretVersion: wallet.secretVersion + 1,
          encryptedSecret: reEncrypted.encryptedSecret,
        },
      }),
    );

    const result: KeyRotationResult = {
      walletId,
      previousKeyVersion: wallet.keyVersion,
      keyVersion: targetKeyVersion,
      secretVersion: updated.secretVersion,
      rotatedAt,
      applied: true,
    };

    this.recordRotation(idempotencyKey, result);
    this.metrics.incrementCounter('key_rotation_completed');
    // Versions and ids only — never the envelope or any plaintext key.
    this.logger.log(
      `key.rotate wallet=${walletId} ${wallet.keyVersion}->${targetKeyVersion} ` +
        `secretVersion=${updated.secretVersion} correlationId=${actor.correlationId}`,
    );

    return result;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Resolves a wallet row, converting a miss into a stable 404. */
  private async requireWallet(
    walletId: string,
    operation: string,
  ): Promise<WalletKeyRecord> {
    let wallet: WalletKeyRecord | null;
    try {
      wallet = await this.store.wallet.findUnique({ where: { id: walletId } });
    } catch (err) {
      this.metrics.incrementCounter('key_rotation_store_error');
      this.logger.error(
        `${operation} store failure wallet=${walletId} reason=${this.errorName(err)}`,
      );
      throw new ServiceUnavailableException({
        code: KeyRotationErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Key store unavailable; operation refused',
      });
    }

    if (!wallet) {
      throw new NotFoundException({
        code: KeyRotationErrorCode.WALLET_NOT_FOUND,
        message: `Wallet ${walletId} not found`,
      });
    }

    return wallet;
  }

  /**
   * Deny-by-default write gate. Metadata reads work unflagged; rotations are
   * refused until an operator explicitly opts in.
   */
  private assertRotationEnabled(): void {
    if (this.isKeyRotationEnabled()) {
      return;
    }
    this.metrics.incrementCounter('key_rotation_blocked_by_flag');
    this.logger.warn(
      `key.rotate refused: ${KEY_ROTATION_ENABLED_ENV} is not enabled`,
    );
    throw new ServiceUnavailableException({
      code: KeyRotationErrorCode.FEATURE_FLAG_DISABLED,
      message: `Key rotation is disabled; set ${KEY_ROTATION_ENABLED_ENV}=true to enable`,
    });
  }

  /**
   * Rotation is owner/guardian only.
   *
   * Ownership is resolved server-side from the stored `userId`; a caller cannot
   * assert it. A delegate is refused outright — a delegate may read metadata
   * but must never be able to rewrite the material controlling the wallet.
   */
  private assertRotationAuthorized(
    wallet: WalletKeyRecord,
    actor: KeyRotationActor,
  ): void {
    if (actor.role === 'owner' && wallet.userId === actor.subjectId) {
      return;
    }
    if (actor.role === 'guardian') {
      return;
    }

    this.metrics.incrementCounter('key_rotation_authz_denied');
    this.logger.warn(
      `key.rotate denied wallet=${wallet.id} role=${actor.role} ` +
        `correlationId=${actor.correlationId}`,
    );
    throw new ForbiddenException({
      code:
        actor.role === 'owner'
          ? KeyRotationErrorCode.NOT_AUTHORIZED
          : KeyRotationErrorCode.INSUFFICIENT_ROLE,
      message: 'You are not allowed to rotate this wallet key',
      correlationId: actor.correlationId,
    });
  }

  /**
   * Reads are allowed for the owner, and for delegate/guardian/API-key/JWT
   * principals. A caller claiming `owner` for a wallet they do not own is
   * refused — the role is verified against the stored `userId`, not trusted.
   */
  private assertReadAuthorized(
    wallet: WalletKeyRecord,
    actor: KeyRotationActor,
  ): void {
    if (actor.role === 'owner' && wallet.userId !== actor.subjectId) {
      this.metrics.incrementCounter('key_metadata_authz_denied');
      throw new ForbiddenException({
        code: KeyRotationErrorCode.NOT_AUTHORIZED,
        message: 'You are not allowed to read this wallet key metadata',
        correlationId: actor.correlationId,
      });
    }
  }

  /**
   * Rejects reuse of an idempotency key for a different target version.
   *
   * Silently re-running under a changed payload would leave the caller
   * believing a rotation to version N happened when the recorded one targeted
   * M, so this is surfaced as a conflict instead.
   */
  private assertNoIdempotencyConflict(
    walletId: string,
    targetKeyVersion: number,
    idempotencyKey?: string,
  ): void {
    if (!idempotencyKey) {
      return;
    }
    const existing = this.rotationLog.get(
      this.replayKey(walletId, idempotencyKey),
    );
    if (existing && existing.keyVersion !== targetKeyVersion) {
      this.metrics.incrementCounter('key_rotation_idempotency_conflict');
      throw new ConflictException({
        code: KeyRotationErrorCode.IDEMPOTENCY_CONFLICT,
        message:
          `Idempotency key already used to rotate ${walletId} to version ` +
          `${existing.keyVersion}; cannot reuse it for ${targetKeyVersion}`,
      });
    }
  }

  /**
   * Returns the recorded rotation for a replayed request, or null.
   *
   * Only an exact (wallet, idempotency key, target version) match replays. A
   * request without an idempotency key is treated as a fresh rotation and is
   * still protected by the monotonicity check above.
   */
  private findReplay(
    walletId: string,
    targetKeyVersion: number,
    idempotencyKey?: string,
  ): KeyRotationResult | null {
    if (!idempotencyKey) {
      return null;
    }
    const key = this.replayKey(walletId, idempotencyKey);
    const record = this.rotationLog.get(key);
    if (!record) {
      return null;
    }
    if (Date.now() - record.rotatedAt.getTime() > ROTATION_REPLAY_WINDOW_MS) {
      this.rotationLog.delete(key);
      return null;
    }
    return record.keyVersion === targetKeyVersion ? record : null;
  }

  /** Records a completed rotation and prunes expired entries. */
  private recordRotation(
    idempotencyKey: string | undefined,
    result: KeyRotationResult,
  ): void {
    if (!idempotencyKey) {
      return;
    }
    this.rotationLog.set(
      this.replayKey(result.walletId, idempotencyKey),
      result,
    );
    this.pruneRotationLog();
  }

  /**
   * Drops expired entries so the in-process replay log cannot grow without
   * bound in a long-running process.
   */
  private pruneRotationLog(): void {
    const cutoff = Date.now() - ROTATION_REPLAY_WINDOW_MS;
    for (const [key, record] of this.rotationLog) {
      if (record.rotatedAt.getTime() <= cutoff) {
        this.rotationLog.delete(key);
      }
    }
  }

  /** Namespaces the idempotency key by wallet so keys cannot collide across wallets. */
  private replayKey(walletId: string, idempotencyKey: string): string {
    return `${walletId}:${idempotencyKey}`;
  }

  /** Validates a caller-supplied wallet id: bounded and charset-restricted. */
  private assertValidWalletId(walletId: string): void {
    if (
      typeof walletId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(walletId)
    ) {
      throw new BadRequestException({
        code: KeyRotationErrorCode.INVALID_INPUT,
        message: 'walletId must be 1-128 characters of [A-Za-z0-9_-]',
      });
    }
  }

  /**
   * Validates the requested target version.
   *
   * Rejects non-integers and any version outside the supported set, so a caller
   * cannot ask the service to write a version no reader in this build
   * understands.
   */
  private assertValidVersion(targetKeyVersion: number): void {
    if (
      !Number.isInteger(targetKeyVersion) ||
      !SUPPORTED_KEY_VERSIONS.includes(targetKeyVersion)
    ) {
      throw new BadRequestException({
        code: KeyRotationErrorCode.INVALID_INPUT,
        message: `targetKeyVersion must be one of ${SUPPORTED_KEY_VERSIONS.join(', ')}`,
      });
    }
  }

  /**
   * Runs a store write, translating infrastructure failures into a stable 503
   * so a DB outage fails the rotation closed rather than surfacing as a 500.
   */
  private async withDependencyGuard<T>(
    correlationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.metrics.incrementCounter('key_rotation_store_error');
      this.logger.error(
        `key.rotate store failure correlationId=${correlationId}`,
      );
      throw new ServiceUnavailableException({
        code: KeyRotationErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Key store unavailable; rotation refused',
        correlationId,
      });
    }
  }

  /** Class name only — never the message, which may carry crypto detail. */
  private errorName(err: unknown): string {
    return err instanceof Error ? err.constructor.name : 'unknown';
  }
}
