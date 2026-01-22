import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface EncryptionResult {
  encryptedData: string;
  iv: string;
  tag: string;
}

export interface DecryptionError extends Error {
  code: 'DECRYPTION_FAILED' | 'INVALID_KEY' | 'INVALID_DATA';
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
    
    if (!key) {
      throw new Error('WALLET_ENCRYPTION_KEY environment variable is required');
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
      const cipher = crypto.createCipherGCM(this.algorithm, this.encryptionKey, iv);
      cipher.setAAD(Buffer.from('wallet-secret', 'utf8'));
      
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const tag = cipher.getAuthTag();
      
      return {
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        tag: tag.toString('hex')
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
      
      const decipher = crypto.createDecipherGCM(this.algorithm, this.encryptionKey, Buffer.from(iv, 'hex'));
      decipher.setAAD(Buffer.from('wallet-secret', 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      
      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      const decryptionError: DecryptionError = new Error('Decryption failed') as DecryptionError;
      
      if (error.message.includes('bad decrypt')) {
        decryptionError.code = 'DECRYPTION_FAILED';
      } else if (error.message.includes('wrong key')) {
        decryptionError.code = 'INVALID_KEY';
      } else {
        decryptionError.code = 'INVALID_DATA';
      }
      
      this.logger.error('Decryption failed:', { error: error.message, code: decryptionError.code });
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
      return JSON.parse(storedData) as EncryptionResult;
    } catch (error) {
      this.logger.error('Failed to deserialize encrypted data:', error);
      throw new Error('Invalid encrypted data format');
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
