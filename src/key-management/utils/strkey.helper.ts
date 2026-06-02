import { StrKey } from 'stellar-sdk';

/**
 * StrKey Encoding Helper for Stellar Key Management
 * 
 * Provides utility functions for encoding and decoding Stellar keys
 * using the StrKey format (base32 with checksums).
 * 
 * Stellar uses specific prefixes:
 * - G for public keys (Ed25519 public key)
 * - S for secret seeds (Ed25519 private key)
 * - M for pre-authorized transaction hashes
 * - X for signed payload signers
 * - T for muxed accounts
 * 
 * This helper wraps stellar-sdk's StrKey functionality with additional
 * validation and error handling.
 */

export class StrKeyHelper {
  /**
   * Encodes an Ed25519 public key to Stellar format (G...)
   * 
   * @param rawPublicKey - 32-byte raw Ed25519 public key
   * @returns Stellar-formatted public key starting with 'G'
   * @throws Error if the key is invalid or wrong length
   */
  static encodeEd25519PublicKey(rawPublicKey: Buffer): string {
    if (!Buffer.isBuffer(rawPublicKey)) {
      throw new Error('Public key must be a Buffer');
    }

    if (rawPublicKey.length !== 32) {
      throw new Error(`Invalid public key length: expected 32 bytes, got ${rawPublicKey.length}`);
    }

    try {
      return StrKey.encodeEd25519PublicKey(rawPublicKey);
    } catch (error) {
      throw new Error(`Failed to encode Ed25519 public key: ${error.message}`);
    }
  }

  /**
   * Encodes an Ed25519 secret seed to Stellar format (S...)
   * 
   * @param rawSeed - 32-byte raw Ed25519 secret seed
   * @returns Stellar-formatted secret seed starting with 'S'
   * @throws Error if the seed is invalid or wrong length
   */
  static encodeEd25519SecretSeed(rawSeed: Buffer): string {
    if (!Buffer.isBuffer(rawSeed)) {
      throw new Error('Secret seed must be a Buffer');
    }

    if (rawSeed.length !== 32) {
      throw new Error(`Invalid secret seed length: expected 32 bytes, got ${rawSeed.length}`);
    }

    try {
      return StrKey.encodeEd25519SecretSeed(rawSeed);
    } catch (error) {
      throw new Error(`Failed to encode Ed25519 secret seed: ${error.message}`);
    }
  }

  /**
   * Decodes a Stellar-formatted Ed25519 public key (G...) to raw bytes
   * 
   * @param encodedKey - Stellar-formatted public key starting with 'G'
   * @returns 32-byte raw Ed25519 public key
   * @throws Error if the key is invalid or malformed
   */
  static decodeEd25519PublicKey(encodedKey: string): Buffer {
    if (typeof encodedKey !== 'string') {
      throw new Error('Encoded key must be a string');
    }

    if (!encodedKey.startsWith('G')) {
      throw new Error(`Invalid public key format: expected key to start with 'G', got '${encodedKey.charAt(0)}'`);
    }

    try {
      return StrKey.decodeEd25519PublicKey(encodedKey);
    } catch (error) {
      throw new Error(`Failed to decode Ed25519 public key: ${error.message}`);
    }
  }

  /**
   * Decodes a Stellar-formatted Ed25519 secret seed (S...) to raw bytes
   * 
   * @param encodedSeed - Stellar-formatted secret seed starting with 'S'
   * @returns 32-byte raw Ed25519 secret seed
   * @throws Error if the seed is invalid or malformed
   */
  static decodeEd25519SecretSeed(encodedSeed: string): Buffer {
    if (typeof encodedSeed !== 'string') {
      throw new Error('Encoded seed must be a string');
    }

    if (!encodedSeed.startsWith('S')) {
      throw new Error(`Invalid secret seed format: expected seed to start with 'S', got '${encodedSeed.charAt(0)}'`);
    }

    try {
      return StrKey.decodeEd25519SecretSeed(encodedSeed);
    } catch (error) {
      throw new Error(`Failed to decode Ed25519 secret seed: ${error.message}`);
    }
  }

  /**
   * Validates if a string is a valid Stellar Ed25519 public key
   * 
   * @param key - String to validate
   * @returns true if valid, false otherwise
   */
  static isValidEd25519PublicKey(key: string): boolean {
    if (typeof key !== 'string') {
      return false;
    }

    try {
      return StrKey.isValidEd25519PublicKey(key);
    } catch {
      return false;
    }
  }

  /**
   * Validates if a string is a valid Stellar Ed25519 secret seed
   * 
   * @param seed - String to validate
   * @returns true if valid, false otherwise
   */
  static isValidEd25519SecretSeed(seed: string): boolean {
    if (typeof seed !== 'string') {
      return false;
    }

    try {
      return StrKey.isValidEd25519SecretSeed(seed);
    } catch {
      return false;
    }
  }

  /**
   * Encodes a pre-authorized transaction hash
   * 
   * @param hash - 32-byte transaction hash
   * @returns Stellar-formatted hash starting with 'T'
   * @throws Error if the hash is invalid
   */
  static encodePreAuthTx(hash: Buffer): string {
    if (!Buffer.isBuffer(hash)) {
      throw new Error('Transaction hash must be a Buffer');
    }

    if (hash.length !== 32) {
      throw new Error(`Invalid hash length: expected 32 bytes, got ${hash.length}`);
    }

    try {
      return StrKey.encodePreAuthTx(hash);
    } catch (error) {
      throw new Error(`Failed to encode pre-authorized transaction: ${error.message}`);
    }
  }

  /**
   * Decodes a pre-authorized transaction hash
   * 
   * @param encoded - Stellar-formatted hash starting with 'T'
   * @returns 32-byte transaction hash
   * @throws Error if invalid
   */
  static decodePreAuthTx(encoded: string): Buffer {
    if (typeof encoded !== 'string') {
      throw new Error('Encoded transaction must be a string');
    }

    try {
      return StrKey.decodePreAuthTx(encoded);
    } catch (error) {
      throw new Error(`Failed to decode pre-authorized transaction: ${error.message}`);
    }
  }

  /**
   * Encodes a SHA256 hash for signing
   * 
   * @param hash - 32-byte hash
   * @returns Stellar-formatted hash starting with 'X'
   * @throws Error if the hash is invalid
   */
  static encodeSha256Hash(hash: Buffer): string {
    if (!Buffer.isBuffer(hash)) {
      throw new Error('Hash must be a Buffer');
    }

    if (hash.length !== 32) {
      throw new Error(`Invalid hash length: expected 32 bytes, got ${hash.length}`);
    }

    try {
      return StrKey.encodeSha256Hash(hash);
    } catch (error) {
      throw new Error(`Failed to encode SHA256 hash: ${error.message}`);
    }
  }

  /**
   * Decodes a SHA256 hash
   * 
   * @param encoded - Stellar-formatted hash starting with 'X'
   * @returns 32-byte hash
   * @throws Error if invalid
   */
  static decodeSha256Hash(encoded: string): Buffer {
    if (typeof encoded !== 'string') {
      throw new Error('Encoded hash must be a string');
    }

    try {
      return StrKey.decodeSha256Hash(encoded);
    } catch (error) {
      throw new Error(`Failed to decode SHA256 hash: ${error.message}`);
    }
  }

  /**
   * Checks if a value is a valid StrKey of any type
   * 
   * @param value - String to check
   * @returns Object with validation results for each type
   */
  static getStrKeyType(value: string): {
    isValid: boolean;
    type: 'publicKey' | 'secretSeed' | 'preAuthTx' | 'sha256Hash' | 'muxedAccount' | 'contract' | 'unknown';
  } {
    if (typeof value !== 'string') {
      return { isValid: false, type: 'unknown' };
    }

    if (this.isValidEd25519PublicKey(value)) {
      return { isValid: true, type: 'publicKey' };
    }

    if (this.isValidEd25519SecretSeed(value)) {
      return { isValid: true, type: 'secretSeed' };
    }

    try {
      // Check for other types
      if (value.startsWith('T')) {
        StrKey.decodePreAuthTx(value);
        return { isValid: true, type: 'preAuthTx' };
      }

      if (value.startsWith('X')) {
        StrKey.decodeSha256Hash(value);
        return { isValid: true, type: 'sha256Hash' };
      }

      if (value.startsWith('M')) {
        return { isValid: true, type: 'muxedAccount' };
      }

      if (value.startsWith('C')) {
        return { isValid: true, type: 'contract' };
      }
    } catch {
      // Invalid format
    }

    return { isValid: false, type: 'unknown' };
  }

  /**
   * Safely checks if a value could be a secret seed without logging it
   * Useful for security validation in production
   * 
   * @param value - Value to check
   * @returns true if it appears to be a secret seed format
   */
  static looksLikeSecretSeed(value: unknown): boolean {
    if (typeof value !== 'string') {
      return false;
    }

    // Quick check without full validation
    return value.startsWith('S') && value.length === 56;
  }

  /**
   * Masks a key for safe logging (shows only first/last chars)
   * 
   * @param key - Key to mask
   * @param prefixLength - Number of characters to show at start (default: 4)
   * @param suffixLength - Number of characters to show at end (default: 4)
   * @returns Masked key string
   */
  static maskKey(key: string, prefixLength: number = 4, suffixLength: number = 4): string {
    if (typeof key !== 'string' || key.length <= prefixLength + suffixLength) {
      return '***';
    }

    const prefix = key.substring(0, prefixLength);
    const suffix = key.substring(key.length - suffixLength);
    const maskedLength = key.length - prefixLength - suffixLength;

    return `${prefix}${'*'.repeat(Math.min(maskedLength, 20))}${suffix}`;
  }
}
