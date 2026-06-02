import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface EncryptionResult {
  encryptedData: string;
  iv: string;
  tag: string;
}

export type DecryptionErrorCode =
  | 'DECRYPTION_FAILED'
  | 'INVALID_KEY'
  | 'INVALID_DATA';

/**
 * Typed error thrown by EncryptionService when decryption fails.
 *
 * Consumers can safely use `instanceof DecryptionError` and inspect `.code`
 * to distinguish corruption, wrong-key, and malformed-data scenarios.
 */
export class DecryptionError extends Error {
  readonly code: DecryptionErrorCode;

  constructor(message: string, code: DecryptionErrorCode) {
    super(message);
    this.name = 'DecryptionError';
    this.code = code;
    // Restore prototype chain broken by ES5 transpilation
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly tagLength = 16; // 128 bits
  private encryptionKey: Buffer;

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

    this.logger.log('Encryption service initialized with secure key');
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
    try {
      const { encryptedData, iv, tag } = encryptionResult;

      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.encryptionKey,
        Buffer.from(iv, 'hex'),
      );
      decipher.setAAD(Buffer.from('wallet-secret', 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));

      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      // Re-throw DecryptionError instances directly (avoid double-wrapping)
      if (error instanceof DecryptionError) {
        throw error;
      }

      let code: DecryptionErrorCode;
      if (
        error.message?.includes('bad decrypt') ||
        error.message?.includes('Unsupported state or unable to authenticate data')
      ) {
        code = 'DECRYPTION_FAILED';
      } else if (error.message?.includes('wrong key')) {
        code = 'INVALID_KEY';
      } else {
        code = 'INVALID_DATA';
      }

      this.logger.error('Decryption failed:', {
        error: error.message,
        code,
      });
      throw new DecryptionError('Decryption failed', code);
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
