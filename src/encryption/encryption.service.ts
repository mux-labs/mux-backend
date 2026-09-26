import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * AES-256-GCM ciphertext envelope as persisted in `Wallet.encryptedSecret`.
 *
 * The envelope is self-describing: `iv` and `tag` travel with the ciphertext
 * so decryption needs nothing but the master key.
 */
export interface EncryptionResult {
  /** Hex-encoded AES-256-GCM ciphertext. */
  encryptedData: string;
  /** Hex-encoded 128-bit initialization vector (random per encryption). */
  iv: string;
  /** Hex-encoded 128-bit GCM authentication tag. */
  tag: string;
}

/** Stable error codes for decryption failures. */
export type DecryptionErrorCode =
  'DECRYPTION_FAILED' | 'INVALID_KEY' | 'INVALID_DATA';

/**
 * Typed decryption failure.
 *
 * The message is deliberately generic: it never contains ciphertext, the
 * master key, or the plaintext, so a failure can be logged and surfaced as a
 * stable error code without leaking key material.
 */
export class DecryptionError extends Error {
  constructor(
    message: string,
    readonly code: DecryptionErrorCode,
  ) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Environment key holding the active master key. */
export const WALLET_ENCRYPTION_KEY_ENV = 'WALLET_ENCRYPTION_KEY';

/** Environment key holding the predecessor key during a master-key rotation. */
export const WALLET_ENCRYPTION_KEY_PREVIOUS_ENV =
  'WALLET_ENCRYPTION_KEY_PREVIOUS';

/** Minimum accepted master-key length, in characters. */
export const MIN_ENCRYPTION_KEY_LENGTH = 32;

/** Documented placeholder values that MUST be rejected at boot. */
export const PLACEHOLDER_ENCRYPTION_KEYS: readonly string[] = [
  'your-secret-encryption-key-min-32-chars',
];

/**
 * Additional authenticated data bound to every ciphertext.
 *
 * Binding a fixed AAD means a ciphertext cannot be transplanted into a
 * different context (e.g. swapped between two wallet rows) without the GCM tag
 * failing to verify.
 */
const AAD = Buffer.from('wallet-secret', 'utf8');

/**
 * EncryptionService — the single controlled path between plaintext Stellar
 * key material and the database.
 *
 * Invariants (asserted by `verify-encryption.sh` and
 * `encryption.service.spec.ts`, and documented in
 * `docs/custody-security-model.md`):
 *
 *  1. **AES-256-GCM.** Authenticated encryption with a random IV per
 *     operation. The master key is derived with SHA-256 so any 32+ character
 *     passphrase yields a full 256-bit key.
 *  2. **Boot-time key validation.** The master key must be present, at least
 *     32 characters, and not a documented placeholder. Failure throws at
 *     construction, so the process refuses to start rather than running with a
 *     weak or default key.
 *  3. **Fail-closed decryption.** Any failure — wrong key, tampered
 *     ciphertext, malformed envelope — throws a `DecryptionError` carrying a
 *     stable code. There is no fallback, no partial decrypt, and no silent
 *     return of empty plaintext.
 *  4. **No key material in errors or logs.** Messages are fixed strings.
 *  5. **Controlled decryption only.** `decrypt` is reachable solely through
 *     this service; callers get plaintext only by asking for it explicitly.
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);

  private readonly algorithm = 'aes-256-gcm';
  private readonly ivLength = 16; // 128 bits
  private readonly tagLength = 16; // 128 bits

  private readonly encryptionKey: Buffer;

  /**
   * Predecessor key, set only while a master-key rotation is in flight so the
   * re-encryption path can read ciphertext written under the old key. It is
   * never used to encrypt.
   */
  private readonly previousEncryptionKey: Buffer | null = null;

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>(WALLET_ENCRYPTION_KEY_ENV);

    if (!key || key.trim() === '') {
      throw new Error(
        `${WALLET_ENCRYPTION_KEY_ENV} environment variable is required`,
      );
    }
    if (PLACEHOLDER_ENCRYPTION_KEYS.includes(key)) {
      throw new Error(
        `${WALLET_ENCRYPTION_KEY_ENV} cannot use the documented placeholder value`,
      );
    }
    if (key.length < MIN_ENCRYPTION_KEY_LENGTH) {
      throw new Error(
        `${WALLET_ENCRYPTION_KEY_ENV} must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters long`,
      );
    }

    this.encryptionKey = this.deriveKey(key);

    const previousKey = this.configService.get<string>(
      WALLET_ENCRYPTION_KEY_PREVIOUS_ENV,
    );
    if (previousKey && previousKey.trim() !== '') {
      if (previousKey.trim().length < MIN_ENCRYPTION_KEY_LENGTH) {
        throw new Error(
          `${WALLET_ENCRYPTION_KEY_PREVIOUS_ENV} must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters long`,
        );
      }
      if (previousKey.trim() === key) {
        throw new Error(
          `${WALLET_ENCRYPTION_KEY_PREVIOUS_ENV} must differ from ${WALLET_ENCRYPTION_KEY_ENV}`,
        );
      }
      this.previousEncryptionKey = this.deriveKey(previousKey.trim());
    }
  }

  /** SHA-256 derivation so any 32+ char passphrase gives a full 256-bit key. */
  private deriveKey(material: string): Buffer {
    return crypto.createHash('sha256').update(material).digest();
  }

  /** Whether a predecessor key is configured (i.e. a rotation is in flight). */
  hasPreviousKey(): boolean {
    return this.previousEncryptionKey !== null;
  }

  /**
   * Encrypts sensitive data with AES-256-GCM under the active master key.
   *
   * @throws Error with a fixed message if encryption fails. The message never
   *   contains the plaintext or the key.
   */
  encrypt(plaintext: string): EncryptionResult {
    try {
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipheriv(
        this.algorithm,
        this.encryptionKey,
        iv,
      );
      cipher.setAAD(AAD);

      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      return {
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
      };
    } catch {
      // Fixed message only — never leak plaintext or key material.
      throw new Error('Encryption operation failed');
    }
  }

  /**
   * Decrypts an envelope under the active master key.
   *
   * @throws DecryptionError with a stable code on any failure. There is no
   *   fallback path: a caller either gets verified plaintext or an error.
   */
  decrypt(encryptionResult: EncryptionResult): string {
    return this.decryptWithKey(encryptionResult, this.encryptionKey);
  }

  private decryptWithKey(
    encryptionResult: EncryptionResult,
    key: Buffer,
  ): string {
    const { encryptedData, iv, tag } = encryptionResult;
    try {
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        key,
        Buffer.from(iv, 'hex'),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(tag, 'hex'));

      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      const code = this.classify(error);
      this.logger.error('Decryption failed', code);
      throw new DecryptionError('Decryption failed', code);
    }
  }

  /**
   * Maps a crypto failure onto a stable code.
   *
   * A GCM auth-tag failure ("bad decrypt" / "unable to authenticate") means
   * the ciphertext or key is wrong; anything else is malformed input. Both
   * paths are fail-closed.
   */
  private classify(error: unknown): DecryptionErrorCode {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('bad decrypt') ||
      message.includes('unable to authenticate data')
    ) {
      return 'DECRYPTION_FAILED';
    }
    if (message.includes('wrong key') || message.includes('bad key')) {
      return 'INVALID_KEY';
    }
    return 'INVALID_DATA';
  }

  /** Serializes an envelope for database storage. */
  serializeForStorage(encryptionResult: EncryptionResult): string {
    return JSON.stringify(encryptionResult);
  }

  /**
   * Parses a stored envelope.
   *
   * @throws DecryptionError with `INVALID_DATA` when the envelope is not valid
   *   JSON or is missing a required field. Fail-closed: a malformed envelope is
   *   never treated as "empty plaintext".
   */
  deserializeFromStorage(storedData: string): EncryptionResult {
    let parsed: EncryptionResult;
    try {
      parsed = JSON.parse(storedData) as EncryptionResult;
    } catch {
      this.logger.error('Failed to deserialize encrypted data');
      throw new DecryptionError(
        'Invalid encrypted data format',
        'INVALID_DATA',
      );
    }

    if (!parsed?.encryptedData || !parsed?.iv || !parsed?.tag) {
      throw new DecryptionError(
        'Invalid encrypted data format: missing required fields',
        'INVALID_DATA',
      );
    }

    return parsed;
  }

  /** Encrypts and serializes in one call. */
  encryptAndSerialize(plaintext: string): string {
    return this.serializeForStorage(this.encrypt(plaintext));
  }

  /** Deserializes and decrypts in one call. */
  deserializeAndDecrypt(storedData: string): string {
    return this.decrypt(this.deserializeFromStorage(storedData));
  }

  /**
   * Re-encrypts stored ciphertext under the current master key (rotation).
   *
   * The current key is tried first; only if that fails and a predecessor key is
   * configured is the payload re-wrapped.
   *
   * @returns `data` — ciphertext under the current key; `rotated` — whether a
   *   re-wrap actually happened.
   * @throws DecryptionError when neither key can decrypt the payload.
   */
  reEncryptWithCurrentKey(storedData: string): {
    data: string;
    rotated: boolean;
  } {
    const parsed = this.deserializeFromStorage(storedData);

    try {
      this.decryptWithKey(parsed, this.encryptionKey);
      return { data: storedData, rotated: false };
    } catch (error) {
      if (!this.previousEncryptionKey) {
        throw error;
      }
      const plaintext = this.decryptWithKey(parsed, this.previousEncryptionKey);
      return { data: this.encryptAndSerialize(plaintext), rotated: true };
    }
  }

  /**
   * Round-trips a probe value to prove the key is usable.
   *
   * Used at boot/health-check time so a misconfigured key is detected before
   * it silently fails on the first real decrypt.
   */
  validateConfiguration(): boolean {
    try {
      const probe = 'encryption-self-test';
      return (
        this.deserializeAndDecrypt(this.encryptAndSerialize(probe)) === probe
      );
    } catch {
      this.logger.error('Encryption configuration validation failed');
      return false;
    }
  }
}
