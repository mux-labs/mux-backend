import { Injectable, Logger } from '@nestjs/common';

/**
 * StrKey type identifiers used in Stellar's address format (SEP-23).
 */
export enum StrKeyType {
  ED25519_PUBLIC_KEY = 'ed25519PublicKey',
  ED25519_SECRET_SEED = 'ed25519SecretSeed',
  PRE_AUTH_TX = 'preAuthTx',
  SHA256_HASH = 'sha256Hash',
}

/**
 * Mapping of StrKey prefix characters to their type identifiers.
 */
const STRKEY_PREFIX_MAP: Record<string, StrKeyType> = {
  G: StrKeyType.ED25519_PUBLIC_KEY,
  S: StrKeyType.ED25519_SECRET_SEED,
  T: StrKeyType.PRE_AUTH_TX,
  X: StrKeyType.SHA256_HASH,
};

/**
 * Version byte constants for StrKey encoding (SEP-23).
 */
const VERSION_BYTES = {
  ED25519_PUBLIC_KEY: 0x30,
  ED25519_SECRET_SEED: 0x10,
  PRE_AUTH_TX: 0x20,
  SHA256_HASH: 0x00,
} as const;

/**
 * Stellar StrKey alphabet (base32 with a custom ordering).
 */
const STRKEY_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * Error codes for StrKey helper operations.
 */
export const StrKeyErrorCode = {
  INVALID_INPUT_TYPE: 'STRKEY_INVALID_INPUT_TYPE',
  INVALID_LENGTH: 'STRKEY_INVALID_LENGTH',
  INVALID_PREFIX: 'STRKEY_INVALID_PREFIX',
  INVALID_CHECKSUM: 'STRKEY_INVALID_CHECKSUM',
  INVALID_KEY_TYPE: 'STRKEY_INVALID_KEY_TYPE',
  ENCODING_FAILED: 'STRKEY_ENCODING_FAILED',
  DECODING_FAILED: 'STRKEY_DECODING_FAILED',
} as const;

export type StrKeyErrorCode =
  (typeof StrKeyErrorCode)[keyof typeof StrKeyErrorCode];

/**
 * Result of a StrKey type detection operation.
 */
export interface StrKeyTypeInfo {
  isValid: boolean;
  type: StrKeyType | null;
  prefix: string | null;
}

/**
 * Result of a StrKey validation operation.
 */
export interface StrKeyValidationResult {
  valid: boolean;
  type: StrKeyType | null;
  error?: string;
}

/**
 * Helper class for encoding, decoding, and validating Stellar StrKey
 * formatted keys (SEP-23).
 *
 * Invariants:
 * - All inputs are validated before processing.
 * - Error messages never contain raw key material.
 * - Validation methods return `false` (never throw) for invalid inputs.
 * - Encoding/decoding methods throw typed errors with stable error codes.
 *
 * @example
 * ```typescript
 * // Encode a raw 32-byte public key
 * const encoded = StrKeyHelper.encodeEd25519PublicKey(rawBuffer);
 * // => "GABC..."
 *
 * // Validate a StrKey-formatted public key
 * const isValid = StrKeyHelper.isValidEd25519PublicKey('GABC...');
 * // => true
 *
 * // Detect the type of a StrKey value
 * const info = StrKeyHelper.getStrKeyType('GABC...');
 * // => { isValid: true, type: 'ed25519PublicKey', prefix: 'G' }
 *
 * // Mask a key for safe logging
 * const masked = StrKeyHelper.maskKey('GABC...');
 * // => "GABC********************XYZ9"
 * ```
 */
@Injectable()
export class StrKeyHelper {
  private readonly logger = new Logger(StrKeyHelper.name);

  // -----------------------------------------------------------------------
  // Encoding
  // -----------------------------------------------------------------------

  /**
   * Encode a raw 32-byte Ed25519 public key buffer to the G... StrKey format.
   *
   * @param buffer - Raw 32-byte public key bytes.
   * @returns StrKey-encoded public key string (e.g., "GABC...").
   * @throws {Error} If input is not a Buffer or not exactly 32 bytes.
   */
  encodeEd25519PublicKey(buffer: Buffer): string {
    this.validateBufferInput(buffer, 'encodeEd25519PublicKey');
    return this.encodeWithVersion(buffer, VERSION_BYTES.ED25519_PUBLIC_KEY, 'G');
  }

  /**
   * Encode a raw 32-byte Ed25519 secret seed buffer to the S... StrKey format.
   *
   * @param buffer - Raw 32-byte secret seed bytes.
   * @returns StrKey-encoded secret seed string (e.g., "SABC...").
   * @throws {Error} If input is not a Buffer or not exactly 32 bytes.
   */
  encodeEd25519SecretSeed(buffer: Buffer): string {
    this.validateBufferInput(buffer, 'encodeEd25519SecretSeed');
    return this.encodeWithVersion(buffer, VERSION_BYTES.ED25519_SECRET_SEED, 'S');
  }

  /**
   * Encode a raw 32-byte transaction hash to the T... StrKey format
   * (pre-authorized transaction).
   *
   * @param buffer - Raw 32-byte transaction hash.
   * @returns StrKey-encoded pre-auth tx string (e.g., "TABC...").
   * @throws {Error} If input is not a Buffer or not exactly 32 bytes.
   */
  encodePreAuthTx(buffer: Buffer): string {
    this.validateBufferInput(buffer, 'encodePreAuthTx');
    return this.encodeWithVersion(buffer, VERSION_BYTES.PRE_AUTH_TX, 'T');
  }

  /**
   * Encode a raw 32-byte SHA256 hash to the X... StrKey format.
   *
   * @param buffer - Raw 32-byte SHA256 hash.
   * @returns StrKey-encoded SHA256 hash string (e.g., "XABC...").
   * @throws {Error} If input is not a Buffer or not exactly 32 bytes.
   */
  encodeSha256Hash(buffer: Buffer): string {
    this.validateBufferInput(buffer, 'encodeSha256Hash');
    return this.encodeWithVersion(buffer, VERSION_BYTES.SHA256_HASH, 'X');
  }

  // -----------------------------------------------------------------------
  // Decoding
  // -----------------------------------------------------------------------

  /**
   * Decode a G... StrKey-formatted Ed25519 public key to raw 32-byte buffer.
   *
   * @param encoded - StrKey-encoded public key string.
   * @returns Raw 32-byte public key buffer.
   * @throws {Error} If the input is not a valid Ed25519 public key StrKey.
   */
  decodeEd25519PublicKey(encoded: string): Buffer {
    return this.decodeWithExpectedPrefix(
      encoded,
      'G',
      StrKeyType.ED25519_PUBLIC_KEY,
      'decodeEd25519PublicKey',
    );
  }

  /**
   * Decode a S... StrKey-formatted Ed25519 secret seed to raw 32-byte buffer.
   *
   * @param encoded - StrKey-encoded secret seed string.
   * @returns Raw 32-byte secret seed buffer.
   * @throws {Error} If the input is not a valid Ed25519 secret seed StrKey.
   */
  decodeEd25519SecretSeed(encoded: string): Buffer {
    return this.decodeWithExpectedPrefix(
      encoded,
      'S',
      StrKeyType.ED25519_SECRET_SEED,
      'decodeEd25519SecretSeed',
    );
  }

  /**
   * Decode a T... StrKey-formatted pre-authorized transaction hash to raw 32-byte buffer.
   *
   * @param encoded - StrKey-encoded pre-auth tx string.
   * @returns Raw 32-byte transaction hash buffer.
   * @throws {Error} If the input is not a valid pre-auth tx StrKey.
   */
  decodePreAuthTx(encoded: string): Buffer {
    return this.decodeWithExpectedPrefix(
      encoded,
      'T',
      StrKeyType.PRE_AUTH_TX,
      'decodePreAuthTx',
    );
  }

  /**
   * Decode an X... StrKey-formatted SHA256 hash to raw 32-byte buffer.
   *
   * @param encoded - StrKey-encoded SHA256 hash string.
   * @returns Raw 32-byte SHA256 hash buffer.
   * @throws {Error} If the input is not a valid SHA256 hash StrKey.
   */
  decodeSha256Hash(encoded: string): Buffer {
    return this.decodeWithExpectedPrefix(
      encoded,
      'X',
      StrKeyType.SHA256_HASH,
      'decodeSha256Hash',
    );
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  /**
   * Validate that a string is a well-formed Ed25519 public key StrKey.
   * Returns `false` for non-string inputs, wrong length, bad prefix, or
   * invalid checksum — never throws.
   *
   * @param value - The value to validate.
   * @returns `true` if the value is a valid G... StrKey public key.
   */
  isValidEd25519PublicKey(value: unknown): boolean {
    try {
      return this.validateWithPrefix(value, 'G', StrKeyType.ED25519_PUBLIC_KEY);
    } catch {
      return false;
    }
  }

  /**
   * Validate that a string is a well-formed Ed25519 secret seed StrKey.
   * Returns `false` for non-string inputs, wrong length, bad prefix, or
   * invalid checksum — never throws.
   *
   * @param value - The value to validate.
   * @returns `true` if the value is a valid S... StrKey secret seed.
   */
  isValidEd25519SecretSeed(value: unknown): boolean {
    try {
      return this.validateWithPrefix(value, 'S', StrKeyType.ED25519_SECRET_SEED);
    } catch {
      return false;
    }
  }

  /**
   * Validate that a string is a well-formed pre-authorized transaction StrKey.
   * Returns `false` for non-string inputs, wrong length, bad prefix, or
   * invalid checksum — never throws.
   *
   * @param value - The value to validate.
   * @returns `true` if the value is a valid T... StrKey pre-auth tx.
   */
  isValidPreAuthTx(value: unknown): boolean {
    try {
      return this.validateWithPrefix(value, 'T', StrKeyType.PRE_AUTH_TX);
    } catch {
      return false;
    }
  }

  /**
   * Validate that a string is a well-formed SHA256 hash StrKey.
   * Returns `false` for non-string inputs, wrong length, bad prefix, or
   * invalid checksum — never throws.
   *
   * @param value - The value to validate.
   * @returns `true` if the value is a valid X... StrKey SHA256 hash.
   */
  isValidSha256Hash(value: unknown): boolean {
    try {
      return this.validateWithPrefix(value, 'X', StrKeyType.SHA256_HASH);
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Type detection
  // -----------------------------------------------------------------------

  /**
   * Identify the type of a StrKey-formatted value.
   *
   * @param value - The StrKey string to inspect.
   * @returns An object describing validity, type, and prefix.
   */
  getStrKeyType(value: unknown): StrKeyTypeInfo {
    if (typeof value !== 'string') {
      return { isValid: false, type: null, prefix: null };
    }

    if (value.length < 2) {
      return { isValid: false, type: null, prefix: null };
    }

    const prefix = value.charAt(0);
    const type = STRKEY_PREFIX_MAP[prefix];

    if (!type) {
      return { isValid: false, type: null, prefix };
    }

    // Verify checksum
    const isValid = this.verifyChecksum(value, prefix);
    return { isValid, type, prefix };
  }

  // -----------------------------------------------------------------------
  // Security utilities
  // -----------------------------------------------------------------------

  /**
   * Quick detection of whether a value looks like a secret seed (starts
   * with 'S' and has the expected length). Does NOT validate the checksum.
   * Useful for preventing accidental logging of secret seeds.
   *
   * @param value - The value to inspect.
   * @returns `true` if the value superficially resembles a secret seed.
   */
  looksLikeSecretSeed(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return value.length === 56 && value.startsWith('S');
  }

  /**
   * Mask a StrKey value for safe logging. Shows the first 6 and last 4
   * characters, replacing the middle with asterisks.
   *
   * @param key - The StrKey string to mask.
   * @param prefixLength - Number of characters to show at the start (default 6).
   * @param suffixLength - Number of characters to show at the end (default 4).
   * @returns The masked string, or '[INVALID]' if input is not a string.
   *
   * @example
   * ```typescript
   * StrKeyHelper.maskKey('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
   * // => "GABCDE**********************34"
   * ```
   */
  maskKey(key: unknown, prefixLength: number = 6, suffixLength: number = 4): string {
    if (typeof key !== 'string') return '[INVALID]';
    if (key.length <= prefixLength + suffixLength) return '[REDACTED]';

    const prefix = key.slice(0, prefixLength);
    const suffix = key.slice(-suffixLength);
    const maskedLength = key.length - prefixLength - suffixLength;

    return `${prefix}${'*'.repeat(maskedLength)}${suffix}`;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private validateBufferInput(buffer: Buffer, methodName: string): void {
    if (!Buffer.isBuffer(buffer)) {
      this.logger.error(
        `${methodName} expects a Buffer input, received ${typeof buffer}`,
      );
      throw new Error(
        `${StrKeyErrorCode.INVALID_INPUT_TYPE}: ${methodName} requires a Buffer`,
      );
    }

    if (buffer.length !== 32) {
      this.logger.error(
        `${methodName} expects a 32-byte buffer, received ${buffer.length} bytes`,
      );
      throw new Error(
        `${StrKeyErrorCode.INVALID_LENGTH}: ${methodName} requires exactly 32 bytes`,
      );
    }
  }

  private encodeWithVersion(buffer: Buffer, versionByte: number, prefix: string): string {
    const payload = Buffer.alloc(1 + buffer.length);
    payload[0] = versionByte;
    buffer.copy(payload, 1);

    const checksum = this.computeChecksum(payload);
    const fullPayload = Buffer.concat([payload, checksum]);

    return prefix + this.base32Encode(fullPayload);
  }

  private decodeWithExpectedPrefix(
    encoded: string,
    expectedPrefix: string,
    expectedType: StrKeyType,
    methodName: string,
  ): Buffer {
    if (typeof encoded !== 'string') {
      throw new Error(
        `${StrKeyErrorCode.DECODING_FAILED}: ${methodName} requires a string input`,
      );
    }

    if (encoded.length !== 56) {
      throw new Error(
        `${StrKeyErrorCode.INVALID_LENGTH}: ${methodName} expects a 56-character StrKey`,
      );
    }

    const prefix = encoded.charAt(0);
    if (prefix !== expectedPrefix) {
      throw new Error(
        `${StrKeyErrorCode.INVALID_PREFIX}: ${methodName} expected prefix '${expectedPrefix}', got '${prefix}'`,
      );
    }

    const decoded = this.base32Decode(encoded.slice(1));

    // Verify checksum
    if (!this.verifyChecksum(encoded, prefix)) {
      throw new Error(
        `${StrKeyErrorCode.INVALID_CHECKSUM}: ${methodName} checksum verification failed`,
      );
    }

    // Extract payload (skip version byte)
    const payload = decoded.slice(1, 33);

    if (payload.length !== 32) {
      throw new Error(
        `${StrKeyErrorCode.DECODING_FAILED}: ${methodName} decoded payload is not 32 bytes`,
      );
    }

    return payload;
  }

  private validateWithPrefix(
    value: unknown,
    expectedPrefix: string,
    expectedType: StrKeyType,
  ): boolean {
    if (typeof value !== 'string') return false;
    if (value.length !== 56) return false;
    if (value.charAt(0) !== expectedPrefix) return false;
    return this.verifyChecksum(value, expectedPrefix);
  }

  /**
   * Verify the StrKey checksum (CRC16-XMODEM) for a given encoded string.
   */
  private verifyChecksum(encoded: string, prefix: string): boolean {
    try {
      const decoded = this.base32Decode(encoded.slice(1));
      if (decoded.length < 3) return false;

      const payload = decoded.slice(0, decoded.length - 2);
      const storedChecksum = decoded.slice(decoded.length - 2);
      const computedChecksum = this.computeChecksum(payload);

      return (
        storedChecksum[0] === computedChecksum[0] &&
        storedChecksum[1] === computedChecksum[1]
      );
    } catch {
      return false;
    }
  }

  private getVersionByte(prefix: string): number {
    switch (prefix) {
      case 'G':
        return VERSION_BYTES.ED25519_PUBLIC_KEY;
      case 'S':
        return VERSION_BYTES.ED25519_SECRET_SEED;
      case 'T':
        return VERSION_BYTES.PRE_AUTH_TX;
      case 'X':
        return VERSION_BYTES.SHA256_HASH;
      default:
        return 0;
    }
  }

  /**
   * Compute the CRC16-XMODEM checksum of a buffer.
   * This is the checksum algorithm used by Stellar StrKey (SEP-23).
   */
  private computeChecksum(data: Buffer): Buffer {
    let crc = 0;

    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 8;

      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc = crc << 1;
        }
        crc &= 0xffff;
      }
    }

    return Buffer.from([(crc >> 8) & 0xff, crc & 0xff]);
  }

  /**
   * Base32-encode a buffer using the Stellar StrKey alphabet.
   */
  private base32Encode(buffer: Buffer): string {
    const alphabet = STRKEY_ALPHABET;
    let result = '';
    let bits = 0;
    let accumulator = 0;

    for (let i = 0; i < buffer.length; i++) {
      accumulator = (accumulator << 8) | buffer[i];
      bits += 8;

      while (bits >= 5) {
        bits -= 5;
        result += alphabet[(accumulator >> bits) & 0x1f];
      }
    }

    if (bits > 0) {
      result += alphabet[(accumulator << (5 - bits)) & 0x1f];
    }

    return result;
  }

  /**
   * Base32-decode a StrKey payload (without the prefix character) using
   * the Stellar StrKey alphabet.
   */
  private base32Decode(encoded: string): Buffer {
    const alphabet = STRKEY_ALPHABET;
    const lookup: Record<string, number> = {};

    for (let i = 0; i < alphabet.length; i++) {
      lookup[alphabet[i]] = i;
    }

    const bits: number[] = [];

    for (let i = 0; i < encoded.length; i++) {
      const char = encoded[i];
      const value = lookup[char];

      if (value === undefined) {
        throw new Error(
          `${StrKeyErrorCode.INVALID_INPUT_TYPE}: Invalid base32 character '${char}'`,
        );
      }

      for (let j = 4; j >= 0; j--) {
        bits.push((value >> j) & 1);
      }
    }

    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        byte = (byte << 1) | bits[i + j];
      }
      bytes.push(byte);
    }

    return Buffer.from(bytes);
  }
}
