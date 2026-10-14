import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/** Environment key holding the active backup encryption key. */
export const BACKUP_ENCRYPTION_KEY_ENV = 'BACKUP_ENCRYPTION_KEY';

/**
 * Environment key holding the predecessor key during a rotation.
 *
 * Set it alongside the new active key, re-encrypt the artifacts, verify with
 * {@link BackupEncryptionService.rotationProbe}, then remove it. The documented
 * runbook is in `docs/BACKUP_RESTORE_PROCEDURES.md` §4.4.
 */
export const BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV =
  'BACKUP_ENCRYPTION_KEY_PREVIOUS';

/** Minimum accepted key length, in characters. */
export const MIN_BACKUP_KEY_LENGTH = 32;

/** Documented placeholder values that MUST be rejected at boot. */
export const PLACEHOLDER_BACKUP_KEYS: readonly string[] = [
  'your-backup-encryption-key-min-32-chars',
];

/** Envelope version prefix. Bumping it is a breaking, reviewable change. */
export const BACKUP_ENVELOPE_VERSION = 'v1';

/** AES-256-GCM parameters used for backup artifacts. */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Authenticated data bound to every backup ciphertext.
 *
 * Binding a fixed context means a backup envelope cannot be swapped in from a
 * different subsystem (e.g. a wallet row) without the GCM tag failing.
 */
const AAD = Buffer.from('backup-artifact', 'utf8');

/** Stable, typed error codes for backup encryption failures. */
export type BackupEncryptionErrorCode =
  | 'BACKUP_KEY_UNAVAILABLE'
  | 'BACKUP_KEY_INVALID'
  | 'BACKUP_KEY_VERSION_UNSUPPORTED'
  | 'BACKUP_DECRYPT_FAILED';

/**
 * Typed failure. Messages are fixed strings and never contain the key, the
 * plaintext, or the ciphertext, so a failure is safe to log and to surface.
 */
export class BackupEncryptionError extends Error {
  constructor(
    message: string,
    readonly code: BackupEncryptionErrorCode,
  ) {
    super(message);
    this.name = 'BackupEncryptionError';
  }
}

/** Ops-safe view of the keyring. Key *ids* are hashes, never key material. */
export interface BackupKeySnapshot {
  version: string;
  activeKeyId: string;
  previousKeyId: string | null;
  /** True while a predecessor key is configured, i.e. a rotation is open. */
  rotationInFlight: boolean;
}

/** Result of the rotation probe used before retiring a predecessor key. */
export interface RotationProbeResult {
  /** The canary artifact round-tripped under the active key. */
  activeKeyWorks: boolean;
  /** Artifacts written under the predecessor key still decrypt. */
  previousKeyWorks: boolean;
  /** False when the predecessor key is retired (normal steady state). */
  previousKeyConfigured: boolean;
  /** Key ids only — never key material. */
  activeKeyId: string;
  previousKeyId: string | null;
}

/**
 * BackupEncryptionService — encryption at rest for backup artifacts (#947).
 *
 * Invariants (documented in `docs/BACKUP_RESTORE_PROCEDURES.md` §4.4/§6,
 * asserted by `backup-encryption.service.spec.ts`):
 *
 *  1. **AES-256-GCM.** Authenticated encryption, a fresh random IV per
 *     encryption, key material derived with SHA-256 (32+ char passphrase).
 *  2. **Fail-closed boot.** A missing, short, or placeholder active key
 *     throws in the constructor: the process refuses to start rather than
 *     storing plaintext backups.
 *  3. **Rotation without downtime.** An envelope records the id of the key
 *     that produced it; `decrypt` accepts the active key or the configured
 *     predecessor, so rotating `BACKUP_ENCRYPTION_KEY` never strands old
 *     artifacts. A retired key's envelope is refused with
 *     `BACKUP_KEY_VERSION_UNSUPPORTED` — there is no silent fallback.
 *  4. **Fail-closed decrypt.** Wrong key, tampered ciphertext, malformed
 *     envelope: every failure throws a typed error. No partial plaintext, no
 *     empty fallback.
 *  5. **No key material anywhere else.** Key ids are truncated hashes; error
 *     messages and snapshots never carry the key, plaintext, or ciphertext.
 */
@Injectable()
export class BackupEncryptionService {
  private readonly active: { id: string; key: Buffer };
  private readonly previous: { id: string; key: Buffer } | null;

  constructor(private readonly configService: ConfigService) {
    const activeMaterial = this.readMaterial(BACKUP_ENCRYPTION_KEY_ENV);
    this.active = {
      id: BackupEncryptionService.keyId(activeMaterial),
      key: BackupEncryptionService.deriveKey(activeMaterial),
    };

    const previousMaterial = (
      this.configService.get<string>(BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV) ?? ''
    ).trim();
    if (previousMaterial === '') {
      this.previous = null;
      return;
    }
    if (
      previousMaterial.length < MIN_BACKUP_KEY_LENGTH ||
      PLACEHOLDER_BACKUP_KEYS.includes(previousMaterial)
    ) {
      throw new BackupEncryptionError(
        `${BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV} must be at least ${MIN_BACKUP_KEY_LENGTH} characters and must not be a documented placeholder`,
        'BACKUP_KEY_INVALID',
      );
    }
    if (previousMaterial === activeMaterial) {
      throw new BackupEncryptionError(
        `${BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV} must differ from ${BACKUP_ENCRYPTION_KEY_ENV}`,
        'BACKUP_KEY_INVALID',
      );
    }
    this.previous = {
      id: BackupEncryptionService.keyId(previousMaterial),
      key: BackupEncryptionService.deriveKey(previousMaterial),
    };
  }

  /** Whether a predecessor key is configured (i.e. a rotation is in flight). */
  hasPreviousKey(): boolean {
    return this.previous !== null;
  }

  /** Ops-safe snapshot: truncated hashes and booleans only. */
  snapshot(): BackupKeySnapshot {
    return {
      version: BACKUP_ENVELOPE_VERSION,
      activeKeyId: this.active.id,
      previousKeyId: this.previous?.id ?? null,
      rotationInFlight: this.previous !== null,
    };
  }

  /** Encrypt a backup artifact under the active key. */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.active.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      BACKUP_ENVELOPE_VERSION,
      this.active.id,
      iv.toString('hex'),
      tag.toString('hex'),
      ciphertext.toString('hex'),
    ].join(':');
  }

  /**
   * Decrypt a backup envelope with the key that wrote it.
   *
   * The active key is tried first; if the envelope names the configured
   * predecessor (a rotation is in flight), that key is used instead. A
   * retired key, a tampered payload, or a malformed envelope all throw —
   * decryption never "succeeds" with empty or partial plaintext.
   *
   * @throws BackupEncryptionError `BACKUP_KEY_VERSION_UNSUPPORTED` |
   *   `BACKUP_DECRYPT_FAILED`
   */
  decrypt(envelope: string): string {
    const parts = typeof envelope === 'string' ? envelope.split(':') : [];
    const [version, keyId, ivHex, tagHex, ciphertextHex] = parts;
    if (
      parts.length !== 5 ||
      version !== BACKUP_ENVELOPE_VERSION ||
      !/^[0-9a-f]{12}$/.test(keyId ?? '')
    ) {
      throw new BackupEncryptionError(
        'Backup envelope is malformed or has an unsupported version',
        'BACKUP_KEY_VERSION_UNSUPPORTED',
      );
    }

    let material: { id: string; key: Buffer } | null = null;
    if (keyId === this.active.id) {
      material = this.active;
    } else if (this.previous && keyId === this.previous.id) {
      material = this.previous;
    }
    if (!material) {
      // The envelope was written under a key we no longer hold: refuse rather
      // than guessing. Rotating back means restoring that key's env var.
      throw new BackupEncryptionError(
        'Backup envelope was written under an encryption key that is not configured',
        'BACKUP_KEY_VERSION_UNSUPPORTED',
      );
    }

    try {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        material.key,
        Buffer.from(ivHex, 'hex'),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Fixed message: never echo the ciphertext or the key.
      throw new BackupEncryptionError(
        'Backup envelope failed authentication; decryption refused',
        'BACKUP_DECRYPT_FAILED',
      );
    }
  }

  /**
   * Re-encrypt an envelope under the active key.
   *
   * This is the rotation primitive: after swapping `BACKUP_ENCRYPTION_KEY`
   * (keeping the old key in `BACKUP_ENCRYPTION_KEY_PREVIOUS`), every stored
   * artifact is passed through here, and only then is the predecessor key
   * removed from the secret manager.
   */
  reencrypt(envelope: string): string {
    return this.encrypt(this.decrypt(envelope));
  }

  /**
   * Canary probe run before a predecessor key is retired.
   *
   * Verifies (a) the active key round-trips and (b) an artifact written under
   * the predecessor still decrypts. `previousKeyWorks` is reported as `true`
   * when no predecessor is configured, so the runbook can treat the probe as
   * "safe to proceed" in both steady state and mid-rotation.
   */
  rotationProbe(
    plaintext = 'mux-backend backup rotation canary',
  ): RotationProbeResult {
    const snapshot = this.snapshot();
    const canary = this.encrypt(plaintext);
    const activeKeyWorks = this.decrypt(canary) === plaintext;

    let previousKeyWorks = true;
    if (this.previous) {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, this.previous.key, iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const envelope = [
        BACKUP_ENVELOPE_VERSION,
        this.previous.id,
        iv.toString('hex'),
        cipher.getAuthTag().toString('hex'),
        ciphertext.toString('hex'),
      ].join(':');
      previousKeyWorks = this.decrypt(envelope) === plaintext;
    }

    return {
      activeKeyWorks,
      previousKeyWorks,
      previousKeyConfigured: this.previous !== null,
      activeKeyId: snapshot.activeKeyId,
      previousKeyId: snapshot.previousKeyId,
    };
  }

  /** Read and validate the active key from configuration (fail-closed). */
  private readMaterial(env: string): string {
    const material = (this.configService.get<string>(env) ?? '').trim();
    if (material === '') {
      throw new BackupEncryptionError(
        `${env} is required; refusing to start without a backup encryption key`,
        'BACKUP_KEY_UNAVAILABLE',
      );
    }
    if (PLACEHOLDER_BACKUP_KEYS.includes(material)) {
      throw new BackupEncryptionError(
        `${env} cannot use the documented placeholder value`,
        'BACKUP_KEY_INVALID',
      );
    }
    if (material.length < MIN_BACKUP_KEY_LENGTH) {
      throw new BackupEncryptionError(
        `${env} must be at least ${MIN_BACKUP_KEY_LENGTH} characters long`,
        'BACKUP_KEY_INVALID',
      );
    }
    return material;
  }

  /** SHA-256 derivation so any 32+ char passphrase yields a full 256-bit key. */
  private static deriveKey(material: string): Buffer {
    return crypto.createHash('sha256').update(material).digest();
  }

  /** Non-reversible id of a key: a truncated hash, safe to log and to return. */
  private static keyId(material: string): string {
    return crypto
      .createHash('sha256')
      .update(material)
      .digest('hex')
      .slice(0, 12);
  }
}
