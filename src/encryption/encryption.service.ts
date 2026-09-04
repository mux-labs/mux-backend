import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SafeLogger } from '../common/safe-logger';

export interface EncryptionResult {
  encryptedData: string;
  iv: string;
  tag: string;
}

export class DecryptionError extends Error {
  code: 'DECRYPTION_FAILED' | 'INVALID_KEY' | 'INVALID_DATA';
  constructor(
    message: string,
    code: 'DECRYPTION_FAILED' | 'INVALID_KEY' | 'INVALID_DATA',
  ) {
    super(message);
    this.name = 'DecryptionError';
    this.code = code;
  }
}

export type DecryptionErrorCode = DecryptionError['code'];

@Injectable()
export class EncryptionService {
  private readonly logger = new SafeLogger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly tagLength = 16; // 128 bits
  private encryptionKey: Buffer;
  /**
   * Optional predecessor key, derived from `WALLET_ENCRYPTION_KEY_PREVIOUS`.
   * Only set while a master-key rotation is in flight so the re-encryption job
   * (#693) can read ciphertext written under the old key. Never used to encrypt.
   */
  private previousEncryptionKey: Buffer | null = null;

  constructor(private configService: ConfigService) {
    const key = this.configService.get<string>('WALLET_ENCRYPTION_KEY');

    if (!key || key.trim() === '') {
      throw new Error('WALLET_ENCRYPTION_KEY environment variable is required');
    }

    if (key === 'your-secret-encryption-key-min-32-chars') {
      throw new Error(
        'WALLET_ENCRYPTION_KEY environment variable cannot use the default placeholder value',
      );
    }

    if (key.length < 32) {
      throw new Error(
        'WALLET_ENCRYPTION_KEY must be at least 32 characters long',
      );
    }

    // Ensure key is exactly 32 bytes (256 bits)
    this.encryptionKey = crypto.createHash('sha256').update(key).digest();

    const previousKey = this.configService.get<string>(
      'WALLET_ENCRYPTION_KEY_PREVIOUS',
    );
    if (previousKey && previousKey.trim() !== '') {
      if (previousKey.trim().length < 32) {
        throw new Error(
          'WALLET_ENCRYPTION_KEY_PREVIOUS must be at least 32 characters long',
        );
      }
      this.previousEncryptionKey = crypto
        .createHash('sha256')
        .update(previousKey)
        .digest();
      this.logger.log(
        'Encryption service loaded a previous key for re-encryption',
      );
    }

    this.logger.log('Encryption service initialized with secure key');
  }

  /**
   * Whether a predecessor key (`WALLET_ENCRYPTION_KEY_PREVIOUS`) is configured.
   */
  hasPreviousKey(): boolean {
    return this.previousEncryptionKey !== null;
  }

  /**
   * Encrypts sensitive data (private keys) using AES-256-GCM
   *
   * @param plaintext - The sensitive data to encrypt
   * @returns Encrypted result with IV and authentication tag
   */
  encrypt(plaintext: string): EncryptionResult {
    try {
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipheriv(
        this.algorithm,
        this.encryptionKey,
        iv,
      );
      cipher.setAAD(Buffer.from('wallet-secret', 'utf8'));

      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const tag = cipher.getAuthTag();

      return {
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
      };
    } catch (error) {
      this.logger.error('Encryption failed:', error);
      throw new Error('Encryption operation failed');
    }
  }

  /**
   * Decrypts encrypted data using AES-256-GCM
   *
   * @param encryptionResult - The encrypted data with IV and tag
   * @returns Decrypted plaintext
   * @throws DecryptionError if decryption fails
   */
  decrypt(encryptionResult: EncryptionResult): string {
    return this.decryptWithKey(encryptionResult, this.encryptionKey);
  }

  private decryptWithKey(
    encryptionResult: EncryptionResult,
    key: Buffer,
  ): string {
    try {
      const { encryptedData, iv, tag } = encryptionResult;

      const decipher = crypto.createDecipheriv(
        this.algorithm,
        key,
        Buffer.from(iv, 'hex'),
      );
      decipher.setAAD(Buffer.from('wallet-secret', 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));

      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      let code: DecryptionError['code'];
      if (error.message.includes('bad decrypt')) {
        code = 'DECRYPTION_FAILED';
      } else if (error.message.includes('wrong key')) {
        code = 'INVALID_KEY';
      } else {
        code = 'INVALID_DATA';
      }

      const decryptionError = new DecryptionError('Decryption failed', code);
      this.logger.error('Decryption failed:', { error: error.message, code });
      throw decryptionError;
    }
  }

  /**
   * Serializes encryption result for database storage
   */
  serializeForStorage(encryptionResult: EncryptionResult): string {
    return JSON.stringify(encryptionResult);
  }

  /**
   * Deserializes encryption result from database storage
   */
  deserializeFromStorage(storedData: string): EncryptionResult {
    try {
      const parsed = JSON.parse(storedData) as EncryptionResult;

      // Validate structure
      if (!parsed.encryptedData || !parsed.iv || !parsed.tag) {
        throw new DecryptionError(
          'Invalid encrypted data format: missing required fields',
          'INVALID_DATA',
        );
      }

      return parsed;
    } catch (error) {
      if (error instanceof DecryptionError) {
        throw error;
      }
      this.logger.error('Failed to deserialize encrypted data:', error);
      throw new DecryptionError(
        'Invalid encrypted data format',
        'INVALID_DATA',
      );
    }
  }

  /**
   * Encrypts and serializes in one operation for convenience
   */
  encryptAndSerialize(plaintext: string): string {
    const encrypted = this.encrypt(plaintext);
    return this.serializeForStorage(encrypted);
  }

  /**
   * Deserializes and decrypts in one operation for convenience
   */
  deserializeAndDecrypt(storedData: string): string {
    const encrypted = this.deserializeFromStorage(storedData);
    return this.decrypt(encrypted);
  }

  /**
   * Re-encrypts stored ciphertext under the CURRENT `WALLET_ENCRYPTION_KEY`
   * (#693, master-key rotation).
   *
   * The current key is tried first; if it cannot decrypt and a previous key
   * (`WALLET_ENCRYPTION_KEY_PREVIOUS`) is configured, the previous key is used.
   *
   * @returns `data` — serialized ciphertext under the current key.
   *          `rotated` — true when the input was decrypted with the previous
   *          key and therefore actually re-wrapped; false when it was already
   *          readable under the current key (no write needed).
   * @throws DecryptionError when neither the current nor the previous key can
   *         decrypt the payload.
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
   * Validates that the encryption key is properly configured
   */
  validateConfiguration(): boolean {
    try {
      // Test encryption/decryption with sample data
      const testData = 'test-validation-data';
      const encrypted = this.encryptAndSerialize(testData);
      const decrypted = this.deserializeAndDecrypt(encrypted);

      return testData === decrypted;
    } catch (error) {
      this.logger.error('Encryption configuration validation failed:', error);
      return false;
    }
  }
}
