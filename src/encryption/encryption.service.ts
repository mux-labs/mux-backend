import { Injectable, Logger } from '@nestjs/common';
import * as CryptoJS from 'crypto-js';

export interface EncryptionResult {
  encryptedData: string;
  iv: string;
  salt: string;
}

export interface DecryptionResult {
  decryptedData: string;
  success: boolean;
  error?: string;
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly encryptionKey: string;

  constructor() {
    // Get encryption key from environment variables
    this.encryptionKey = this.getEncryptionKey();
    
    if (!this.encryptionKey) {
      throw new Error('WALLET_ENCRYPTION_KEY environment variable is required');
    }
    
    this.logger.log('Encryption service initialized with environment-based key');
  }

  /**
   * Encrypt sensitive data (private keys) using AES-256-CBC
   */
  encrypt(plainText: string): EncryptionResult {
    try {
      // Generate random salt and IV for each encryption
      const salt = CryptoJS.lib.WordArray.random(16);
      const iv = CryptoJS.lib.WordArray.random(16);
      
      // Derive key using PBKDF2
      const key = CryptoJS.PBKDF2(this.encryptionKey, salt, {
        keySize: 256/32, // 256 bits
        iterations: 10000,
      });

      // Encrypt using AES-256-CBC
      const encrypted = CryptoJS.AES.encrypt(plainText, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });

      const result: EncryptionResult = {
        encryptedData: encrypted.toString(),
        iv: CryptoJS.enc.Base64.stringify(iv),
        salt: CryptoJS.enc.Base64.stringify(salt),
      };

      this.logger.debug('Successfully encrypted sensitive data');
      return result;
    } catch (error) {
      this.logger.error('Failed to encrypt data', error);
      throw new Error('Encryption failed: ' + error.message);
    }
  }

  /**
   * Decrypt sensitive data (private keys) using AES-256-CBC
   */
  decrypt(encryptedResult: EncryptionResult): DecryptionResult {
    try {
      const { encryptedData, iv, salt } = encryptedResult;

      // Validate input
      if (!encryptedData || !iv || !salt) {
        throw new Error('Invalid encrypted data format');
      }

      // Parse IV and salt
      const ivParsed = CryptoJS.enc.Base64.parse(iv);
      const saltParsed = CryptoJS.enc.Base64.parse(salt);

      // Derive key using PBKDF2 (same parameters as encryption)
      const key = CryptoJS.PBKDF2(this.encryptionKey, saltParsed, {
        keySize: 256/32, // 256 bits
        iterations: 10000,
      });

      // Decrypt using AES-256-CBC
      const decrypted = CryptoJS.AES.decrypt(encryptedData, key, {
        iv: ivParsed,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });

      const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);

      // Validate decryption result
      if (!decryptedText || decryptedText.length === 0) {
        throw new Error('Decryption resulted in empty data - invalid key or corrupted data');
      }

      this.logger.debug('Successfully decrypted sensitive data');
      return {
        decryptedData: decryptedText,
        success: true,
      };
    } catch (error) {
      this.logger.error('Failed to decrypt data', error);
      return {
        decryptedData: '',
        success: false,
        error: `Decryption failed: ${error.message}`,
      };
    }
  }

  /**
   * Simple encrypt/decrypt for backward compatibility
   * (Used by existing wallet creation orchestrator)
   */
  encryptSimple(plainText: string): string {
    try {
      const result = this.encrypt(plainText);
      // Store all components in a single string for compatibility
      return `${result.salt}:${result.iv}:${result.encryptedData}`;
    } catch (error) {
      this.logger.error('Simple encryption failed', error);
      throw new Error('Simple encryption failed: ' + error.message);
    }
  }

  /**
   * Simple decrypt for backward compatibility
   */
  decryptSimple(encryptedString: string): DecryptionResult {
    try {
      const parts = encryptedString.split(':');
      if (parts.length !== 3) {
        throw new Error('Invalid encrypted string format');
      }

      const [salt, iv, encryptedData] = parts;
      return this.decrypt({
        salt,
        iv,
        encryptedData,
      });
    } catch (error) {
      this.logger.error('Simple decryption failed', error);
      return {
        decryptedData: '',
        success: false,
        error: `Simple decryption failed: ${error.message}`,
      };
    }
  }

  /**
   * Get encryption key from environment
   */
  private getEncryptionKey(): string {
    // Try multiple environment variable names for flexibility
    const keyNames = [
      'WALLET_ENCRYPTION_KEY',
      'ENCRYPTION_KEY',
      'WALLET_PRIVATE_KEY_ENCRYPTION',
    ];

    for (const keyName of keyNames) {
      const key = process.env[keyName];
      if (key && key.length >= 32) {
        this.logger.debug(`Using encryption key from ${keyName}`);
        return key;
      }
    }

    // Log available environment variables (without values) for debugging
    const availableKeys = Object.keys(process.env).filter(key => 
      key.includes('ENCRYPT') || key.includes('WALLET') || key.includes('KEY')
    );
    
    this.logger.error(`No valid encryption key found. Available related env vars: ${availableKeys.join(', ')}`);
    
    return '';
  }

  /**
   * Validate encryption key strength
   */
  validateEncryptionKey(): boolean {
    try {
      // Test encryption/decryption with sample data
      const testData = 'test-encryption-validation';
      const encrypted = this.encrypt(testData);
      const decrypted = this.decrypt(encrypted);
      
      return decrypted.success && decrypted.decryptedData === testData;
    } catch (error) {
      this.logger.error('Encryption key validation failed', error);
      return false;
    }
  }

  /**
   * Generate a secure encryption key (for development/testing only)
   */
  static generateSecureKey(): string {
    return CryptoJS.lib.WordArray.random(32).toString();
  }
}
