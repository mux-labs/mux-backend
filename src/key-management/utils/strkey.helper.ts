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
    return this.decodeWithVersion(
      encoded,
      VERSION_BYTES.ED25519_PUBLIC_KEY,
      'G',
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
    return this.decodeWithVersion(
      encoded,
      VERSION_BYTES.ED25519_SECRET_SEED,
      'S',
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
    return this.decodeWithVersion(encoded, VERSION_BYTES.PRE_AUTH_TX, 'T');
  }

  /**
   * Decode an X... StrKey-formatted SHA256 hash to raw 32-byte buffer.
   *
   * @param encoded - StrKey-encoded SHA256 hash string.
   * @returns Raw 32-byte SHA256 hash buffer.
   * @throws {Error} If the input is not a valid SHA256 hash StrKey.
   */
  decodeSha256Hash(encoded: string): Buffer {
    return this.decodeWithVersion(encoded, VERSION_BYTES.SHA256_HASH, 'X');
  }

  /**
   * Decode a StrKey value with an expected version byte and prefix.
   *
   * Validates input type, prefix, length, alphabet membership and the
   * trailing 2-byte little-endian CRC16-XModem checksum. Error messages
   * never include the raw key material.
   *
   * @param value - The StrKey-encoded string to decode.
   * @param expectedVersion - The expected version byte for this key type.
   * @param expectedPrefix - The expected leading prefix character.
   * @returns The raw 32-byte payload buffer.
   */
  private decodeWithVersion(
    value: string,
    expectedVersion: number,
    expectedPrefix: string,
  ): Buffer {
    if (typeof value !== 'string') {
      throw this.createError(
        StrKeyErrorCode.INVALID_INPUT_TYPE,
        'StrKey value must be a string',
      );
    }

    if (value.length === 0 || value[0] !== expectedPrefix) {
      throw this.createError(
        StrKeyErrorCode.INVALID_PREFIX,
        `StrKey value must start with the expected prefix`,
      );
    }

    if (value.length !== 56) {
      throw this.createError(
        StrKeyErrorCode.INVALID_LENGTH,
        'StrKey value must be exactly 56 characters long',
      );
    }

    // Decode the base32 payload (everything after the prefix character).
    const decoded = this.base32Decode(value.slice(1));

    // The decoded bytes are: [version byte][32-byte payload][2-byte checksum].
    if (decoded.length !== 35) {
      throw this.createError(
        StrKeyErrorCode.INVALID_LENGTH,
        'StrKey value has an invalid decoded length',
      );
    }

    if (decoded[0] !== expectedVersion) {
      throw this.createError(
        StrKeyErrorCode.INVALID_PREFIX,
        'StrKey value has an unexpected version byte',
      );
    }

    const payload = decoded.subarray(1, 33);
    const checksum = decoded.readUInt16LE(33);
    const expectedChecksum = this.crc16XModem(decoded.subarray(0, 33));

    if (checksum !== expectedChecksum) {
      throw this.createError(
        StrKeyErrorCode.INVALID_CHECKSUM,
        'StrKey value has an invalid checksum',
      );
    }

    return Buffer.from(payload);
  }

  /**
   * Decode a base32 string using the Stellar StrKey alphabet.
   *
   * @param input - The base32-encoded string (without prefix).
   * @returns The decoded bytes.
   * @throws {Error} With `INVALID_LENGTH` if an unknown character is found.
   */
  private base32Decode(input: string): Buffer {
    let bits = 0;
    let value = 0;
    const output: number[] = [];

    for (const char of input) {
      const index = STRKEY_ALPHABET.indexOf(char);
      if (index === -1) {
        throw this.createError(
          StrKeyErrorCode.INVALID_LENGTH,
          'StrKey value contains an invalid character',
        );
      }

      value = (value << 5) | index;
      bits += 5;

      if (bits >= 8) {
        bits -= 8;
        output.push((value >>> bits) & 0xff);
      }
    }

    return Buffer.from(output);
  }

  /**
   * Compute the CRC16-XModem checksum over the given bytes.
   *
   * @param data - The bytes to checksum.
   * @returns The 16-bit checksum value.
   */
  private crc16XModem(data: Buffer): number {
    let crc = 0x0000;

    for (const byte of data) {
      crc ^= byte << 8;
      for (let i = 0; i < 8; i++) {
        if ((crc & 0x8000) !== 0) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }

    return crc & 0xffff;
  }

  /**
   * Create a typed StrKey error that never includes raw key material.
   *
   * @param code - The stable StrKey error code.
   * @param message - A safe, key-material-free message.
   * @returns The constructed error.
   */
  private createError(code: StrKeyErrorCode, message: string): Error {
    const error = new Error(message);
    (error as Error & { code?: StrKeyErrorCode }).code = code;
    return error;
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
   * Validate a StrKey value against an expected prefix and type.
   *
   * @param value - The value to validate.
   * @param prefix - The expected leading prefix character.
   * @param type - The expected StrKey type.
   * @returns `true` if the value is a valid StrKey of the expected type.
   */
  private validateWithPrefix(
    value: unknown,
    prefix: string,
    type: StrKeyType,
  ): boolean {
    if (typeof value !== 'string') {
      return false;
    }

    if (value.length !== 56 || value[0] !== prefix) {
      return false;
    }

    const version = this.versionForType(type);
    try {
      this.decodeWithVersion(value, version, prefix);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the version byte for a given StrKey type.
   *
   * @param type - The StrKey type.
   * @returns The corresponding version byte.
   */
  private versionForType(type: StrKeyType): number {
    switch (type) {
      case StrKeyType.ED25519_PUBLIC_KEY:
        return VERSION_BYTES.ED25519_PUBLIC_KEY;
      case StrKeyType.ED25519_SECRET_SEED:
        return VERSION_BYTES.ED25519_SECRET_SEED;
      case StrKeyType.PRE_AUTH_TX:
        return VERSION_BYTES.PRE_AUTH_TX;
      case StrKeyType.SHA256_HASH:
        return VERSION_BYTES.SHA256_HASH;
      default:
        throw this.createError(
          StrKeyErrorCode.INVALID_KEY_TYPE,
          'Unknown StrKey type',
        );
    }
  }

  /**
   * Validate that a buffer input is a Buffer of exactly 32 bytes.
   *
   * @param buffer - The buffer to validate.
   * @param method - The calling method name (for safe error context).
   */
  private validateBufferInput(buffer: Buffer, method: string): void {
    if (!Buffer.isBuffer(buffer)) {
      throw this.createError(
        StrKeyErrorCode.INVALID_INPUT_TYPE,
        `${method}: input must be a Buffer`,
      );
    }

    if (buffer.length !== 32) {
      throw this.createError(
        StrKeyErrorCode.INVALID_LENGTH,
        `${method}: input must be exactly 32 bytes`,
      );
    }
  }

  /**
   * Encode a raw 32-byte buffer with the given version byte and prefix.
   *
   * @param buffer - Raw 32-byte payload.
   * @param version - The version byte to prepend.
   * @param prefix - The leading prefix character.
   * @returns The StrKey-encoded string.
   */
  private encodeWithVersion(
    buffer: Buffer,
    version: number,
    prefix: string,
  ): string {
    const versioned = Buffer.concat([Buffer.from([version]), buffer]);
    const checksum = this.crc16XModem(versioned);
    const checksumBytes = Buffer.alloc(2);
    checksumBytes.writeUInt16LE(checksum, 0);

    const payload = Buffer.concat([versioned, checksumBytes]);
    return prefix + this.base32Encode(payload);
  }

  /**
   * Encode bytes to a base32 string using the Stellar StrKey alphabet.
   *
   * @param data - The bytes to encode.
   * @returns The base32-encoded string.
   */
  private base32Encode(data: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of data) {
      value = (value << 8) | byte;
      bits += 8;

      while (bits >= 5) {
        bits -= 5;
        output += STRKEY_ALPHABET[(value >>> bits) & 0x1f];
      }
    }

    if (bits > 0) {
      output += STRKEY_ALPHABET[(value << (5 - bits)) & 0x1f];
    }

    return output;
  }

  /**
   * Detect the StrKey type of a value.
   *
   * @param value - The value to inspect.
   * @returns Type information including validity, type and prefix.
   */
  getStrKeyType(value: unknown): StrKeyTypeInfo {
    if (typeof value !== 'string' || value.length === 0) {
      return { isValid: false, type: null, prefix: null };
    }

    const prefix = value[0];
    const type = STRKEY_PREFIX_MAP[prefix] ?? null;

    if (type === null) {
      return { isValid: false, type: null, prefix };
    }

    const isValid = this.validateWithPrefix(
      value,
      prefix,
      type,
    );

    return { isValid, type: isValid ? type : null, prefix };
  }

  /**
   * Mask a StrKey value for safe logging.
   *
   * @param value - The StrKey value to mask.
   * @returns A masked representation that preserves the prefix and suffix.
   */
  maskKey(value: string): string {
    if (typeof value !== 'string' || value.length <= 8) {
      return '****';
    }

    const prefix = value.slice(0, 4);
    const suffix = value.slice(-4);
    const masked = '*'.repeat(Math.max(0, value.length - 8));
    return `${prefix}${masked}${suffix}`;
  }
}
