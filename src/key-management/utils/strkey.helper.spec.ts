import { Test, TestingModule } from '@nestjs/testing';
import { StrKeyHelper, StrKeyType, StrKeyErrorCode } from './strkey.helper';

describe('StrKeyHelper', () => {
  let helper: StrKeyHelper;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StrKeyHelper],
    }).compile();

    helper = module.get<StrKeyHelper>(StrKeyHelper);
  });

  // -----------------------------------------------------------------------
  // encodeEd25519PublicKey
  // -----------------------------------------------------------------------

  describe('encodeEd25519PublicKey', () => {
    it('encodes a valid 32-byte buffer to a G... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer[0] = 0x30; // version byte for public key
      buffer.fill(0x01, 1);

      const encoded = helper.encodeEd25519PublicKey(buffer);

      expect(encoded).toMatch(/^G[A-Z2-7]{55}$/);
      expect(encoded.length).toBe(56);
    });

    it('produces a deterministic result for the same input', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x42);

      const encoded1 = helper.encodeEd25519PublicKey(buffer);
      const encoded2 = helper.encodeEd25519PublicKey(buffer);

      expect(encoded1).toBe(encoded2);
    });

    it('throws when input is not a Buffer', () => {
      expect(() => helper.encodeEd25519PublicKey('not-a-buffer' as any)).toThrow(
        /STRKEY_INVALID_INPUT_TYPE/,
      );
    });

    it('throws when buffer is not 32 bytes', () => {
      expect(() => helper.encodeEd25519PublicKey(Buffer.alloc(16))).toThrow(
        /STRKEY_INVALID_LENGTH/,
      );

      expect(() => helper.encodeEd25519PublicKey(Buffer.alloc(64))).toThrow(
        /STRKEY_INVALID_LENGTH/,
      );
    });

    it('throws when buffer is empty', () => {
      expect(() => helper.encodeEd25519PublicKey(Buffer.alloc(0))).toThrow(
        /STRKEY_INVALID_LENGTH/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // encodeEd25519SecretSeed
  // -----------------------------------------------------------------------

  describe('encodeEd25519SecretSeed', () => {
    it('encodes a valid 32-byte buffer to an S... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer[0] = 0x10; // version byte for secret seed
      buffer.fill(0x01, 1);

      const encoded = helper.encodeEd25519SecretSeed(buffer);

      expect(encoded).toMatch(/^S[A-Z2-7]{55}$/);
      expect(encoded.length).toBe(56);
    });

    it('throws when input is not a Buffer', () => {
      expect(() => helper.encodeEd25519SecretSeed(123 as any)).toThrow(
        /STRKEY_INVALID_INPUT_TYPE/,
      );
    });

    it('throws when buffer is not 32 bytes', () => {
      expect(() => helper.encodeEd25519SecretSeed(Buffer.alloc(16))).toThrow(
        /STRKEY_INVALID_LENGTH/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // encodePreAuthTx
  // -----------------------------------------------------------------------

  describe('encodePreAuthTx', () => {
    it('encodes a valid 32-byte buffer to a T... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0xAB);

      const encoded = helper.encodePreAuthTx(buffer);

      expect(encoded).toMatch(/^T[A-Z2-7]{55}$/);
      expect(encoded.length).toBe(56);
    });

    it('throws when input is not a Buffer', () => {
      expect(() => helper.encodePreAuthTx(null as any)).toThrow(
        /STRKEY_INVALID_INPUT_TYPE/,
      );
    });

    it('throws when buffer is not 32 bytes', () => {
      expect(() => helper.encodePreAuthTx(Buffer.alloc(1))).toThrow(
        /STRKEY_INVALID_LENGTH/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // encodeSha256Hash
  // -----------------------------------------------------------------------

  describe('encodeSha256Hash', () => {
    it('encodes a valid 32-byte buffer to an X... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0xCD);

      const encoded = helper.encodeSha256Hash(buffer);

      expect(encoded).toMatch(/^X[A-Z2-7]{55}$/);
      expect(encoded.length).toBe(56);
    });

    it('throws when input is not a Buffer', () => {
      expect(() => helper.encodeSha256Hash(undefined as any)).toThrow(
        /STRKEY_INVALID_INPUT_TYPE/,
      );
    });

    it('throws when buffer is not 32 bytes', () => {
      expect(() => helper.encodeSha256Hash(Buffer.alloc(33))).toThrow(
        /STRKEY_INVALID_LENGTH/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // decodeEd25519PublicKey
  // -----------------------------------------------------------------------

  describe('decodeEd25519PublicKey', () => {
    it('decodes a valid G... StrKey to a 32-byte buffer', () => {
      const originalBuffer = Buffer.alloc(32);
      originalBuffer.fill(0x01);

      const encoded = helper.encodeEd25519PublicKey(originalBuffer);
      const decoded = helper.decodeEd25519PublicKey(encoded);

      expect(decoded).toBeInstanceOf(Buffer);
      expect(decoded.length).toBe(32);
      expect(decoded.equals(originalBuffer)).toBe(true);
    });

    it('round-trips correctly for random data', () => {
      const originalBuffer = Buffer.from(
        'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
        'hex',
      );

      const encoded = helper.encodeEd25519PublicKey(originalBuffer);
      const decoded = helper.decodeEd25519PublicKey(encoded);

      expect(decoded.equals(originalBuffer)).toBe(true);
    });

    it('throws when input is not a string', () => {
      expect(() => helper.decodeEd25519PublicKey(123 as any)).toThrow(
        /STRKEY_DECODING_FAILED/,
      );
    });

    it('throws when string has wrong length', () => {
      expect(() => helper.decodeEd25519PublicKey('GABC')).toThrow(
        /STRKEY_INVALID_LENGTH/,
      );
    });

    it('throws when prefix is wrong (S instead of G)', () => {
      const secretSeedBuffer = Buffer.alloc(32);
      secretSeedBuffer.fill(0x01);
      const encoded = helper.encodeEd25519SecretSeed(secretSeedBuffer);

      expect(() => helper.decodeEd25519PublicKey(encoded)).toThrow(
        /STRKEY_INVALID_PREFIX/,
      );
    });

    it('throws when checksum is invalid', () => {
      // Take a valid key and corrupt the last character
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);
      const corrupted = encoded.slice(0, -1) + 'Z';

      expect(() => helper.decodeEd25519PublicKey(corrupted)).toThrow(
        /STRKEY_INVALID_CHECKSUM/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // decodeEd25519SecretSeed
  // -----------------------------------------------------------------------

  describe('decodeEd25519SecretSeed', () => {
    it('decodes a valid S... StrKey to a 32-byte buffer', () => {
      const originalBuffer = Buffer.alloc(32);
      originalBuffer.fill(0x02);

      const encoded = helper.encodeEd25519SecretSeed(originalBuffer);
      const decoded = helper.decodeEd25519SecretSeed(encoded);

      expect(decoded.length).toBe(32);
      expect(decoded.equals(originalBuffer)).toBe(true);
    });

    it('throws when prefix is wrong (G instead of S)', () => {
      const publicKeyBuffer = Buffer.alloc(32);
      publicKeyBuffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(publicKeyBuffer);

      expect(() => helper.decodeEd25519SecretSeed(encoded)).toThrow(
        /STRKEY_INVALID_PREFIX/,
      );
    });

    it('throws when checksum is invalid', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519SecretSeed(buffer);
      const corrupted = encoded.slice(0, -1) + 'Z';

      expect(() => helper.decodeEd25519SecretSeed(corrupted)).toThrow(
        /STRKEY_INVALID_CHECKSUM/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // decodePreAuthTx
  // -----------------------------------------------------------------------

  describe('decodePreAuthTx', () => {
    it('decodes a valid T... StrKey to a 32-byte buffer', () => {
      const originalBuffer = Buffer.alloc(32);
      originalBuffer.fill(0x03);

      const encoded = helper.encodePreAuthTx(originalBuffer);
      const decoded = helper.decodePreAuthTx(encoded);

      expect(decoded.length).toBe(32);
      expect(decoded.equals(originalBuffer)).toBe(true);
    });

    it('throws when prefix is wrong', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);

      expect(() => helper.decodePreAuthTx(encoded)).toThrow(
        /STRKEY_INVALID_PREFIX/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // decodeSha256Hash
  // -----------------------------------------------------------------------

  describe('decodeSha256Hash', () => {
    it('decodes a valid X... StrKey to a 32-byte buffer', () => {
      const originalBuffer = Buffer.alloc(32);
      originalBuffer.fill(0x04);

      const encoded = helper.encodeSha256Hash(originalBuffer);
      const decoded = helper.decodeSha256Hash(encoded);

      expect(decoded.length).toBe(32);
      expect(decoded.equals(originalBuffer)).toBe(true);
    });

    it('throws when prefix is wrong', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);

      expect(() => helper.decodeSha256Hash(encoded)).toThrow(
        /STRKEY_INVALID_PREFIX/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // isValidEd25519PublicKey
  // -----------------------------------------------------------------------

  describe('isValidEd25519PublicKey', () => {
    it('returns true for a valid G... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);

      expect(helper.isValidEd25519PublicKey(encoded)).toBe(true);
    });

    it('returns false for a string with wrong prefix', () => {
      expect(helper.isValidEd25519PublicKey('SABC...')).toBe(false);
    });

    it('returns false for a string with wrong length', () => {
      expect(helper.isValidEd25519PublicKey('GABC')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(helper.isValidEd25519PublicKey(123)).toBe(false);
      expect(helper.isValidEd25519PublicKey(null)).toBe(false);
      expect(helper.isValidEd25519PublicKey(undefined)).toBe(false);
      expect(helper.isValidEd25519PublicKey({})).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(helper.isValidEd25519PublicKey('')).toBe(false);
    });

    it('returns false for a string with invalid characters', () => {
      expect(helper.isValidEd25519PublicKey('GABC...invalid!@#')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isValidEd25519SecretSeed
  // -----------------------------------------------------------------------

  describe('isValidEd25519SecretSeed', () => {
    it('returns true for a valid S... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x02);
      const encoded = helper.encodeEd25519SecretSeed(buffer);

      expect(helper.isValidEd25519SecretSeed(encoded)).toBe(true);
    });

    it('returns false for a string with wrong prefix', () => {
      expect(helper.isValidEd25519SecretSeed('GABC...')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(helper.isValidEd25519SecretSeed(123)).toBe(false);
      expect(helper.isValidEd25519SecretSeed(null)).toBe(false);
      expect(helper.isValidEd25519SecretSeed(undefined)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isValidPreAuthTx
  // -----------------------------------------------------------------------

  describe('isValidPreAuthTx', () => {
    it('returns true for a valid T... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x03);
      const encoded = helper.encodePreAuthTx(buffer);

      expect(helper.isValidPreAuthTx(encoded)).toBe(true);
    });

    it('returns false for a string with wrong prefix', () => {
      expect(helper.isValidPreAuthTx('GABC...')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(helper.isValidPreAuthTx(123)).toBe(false);
      expect(helper.isValidPreAuthTx(null)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isValidSha256Hash
  // -----------------------------------------------------------------------

  describe('isValidSha256Hash', () => {
    it('returns true for a valid X... StrKey', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x04);
      const encoded = helper.encodeSha256Hash(buffer);

      expect(helper.isValidSha256Hash(encoded)).toBe(true);
    });

    it('returns false for a string with wrong prefix', () => {
      expect(helper.isValidSha256Hash('GABC...')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(helper.isValidSha256Hash(123)).toBe(false);
      expect(helper.isValidSha256Hash(null)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getStrKeyType
  // -----------------------------------------------------------------------

  describe('getStrKeyType', () => {
    it('identifies a valid public key', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);

      const info = helper.getStrKeyType(encoded);
      expect(info.isValid).toBe(true);
      expect(info.type).toBe(StrKeyType.ED25519_PUBLIC_KEY);
      expect(info.prefix).toBe('G');
    });

    it('identifies a valid secret seed', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x02);
      const encoded = helper.encodeEd25519SecretSeed(buffer);

      const info = helper.getStrKeyType(encoded);
      expect(info.isValid).toBe(true);
      expect(info.type).toBe(StrKeyType.ED25519_SECRET_SEED);
      expect(info.prefix).toBe('S');
    });

    it('identifies a valid pre-auth tx', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x03);
      const encoded = helper.encodePreAuthTx(buffer);

      const info = helper.getStrKeyType(encoded);
      expect(info.isValid).toBe(true);
      expect(info.type).toBe(StrKeyType.PRE_AUTH_TX);
      expect(info.prefix).toBe('T');
    });

    it('identifies a valid SHA256 hash', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x04);
      const encoded = helper.encodeSha256Hash(buffer);

      const info = helper.getStrKeyType(encoded);
      expect(info.isValid).toBe(true);
      expect(info.type).toBe(StrKeyType.SHA256_HASH);
      expect(info.prefix).toBe('X');
    });

    it('returns isValid: false for an invalid checksum', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);
      const corrupted = encoded.slice(0, -1) + 'Z';

      const info = helper.getStrKeyType(corrupted);
      expect(info.isValid).toBe(false);
      expect(info.type).toBe(StrKeyType.ED25519_PUBLIC_KEY);
      expect(info.prefix).toBe('G');
    });

    it('returns isValid: false for an unknown prefix', () => {
      const info = helper.getStrKeyType('ZABC...');
      expect(info.isValid).toBe(false);
      expect(info.type).toBeNull();
      expect(info.prefix).toBe('Z');
    });

    it('returns isValid: false for non-string inputs', () => {
      expect(helper.getStrKeyType(123)).toEqual({
        isValid: false,
        type: null,
        prefix: null,
      });
      expect(helper.getStrKeyType(null)).toEqual({
        isValid: false,
        type: null,
        prefix: null,
      });
      expect(helper.getStrKeyType(undefined)).toEqual({
        isValid: false,
        type: null,
        prefix: null,
      });
    });

    it('returns isValid: false for empty string', () => {
      const info = helper.getStrKeyType('');
      expect(info.isValid).toBe(false);
      expect(info.type).toBeNull();
      expect(info.prefix).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // looksLikeSecretSeed
  // -----------------------------------------------------------------------

  describe('looksLikeSecretSeed', () => {
    it('returns true for a string starting with S and length 56', () => {
      expect(helper.looksLikeSecretSeed('SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12')).toBe(true);
    });

    it('returns false for a public key (G prefix)', () => {
      expect(helper.looksLikeSecretSeed('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12')).toBe(false);
    });

    it('returns false for wrong length', () => {
      expect(helper.looksLikeSecretSeed('SABC')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(helper.looksLikeSecretSeed(123)).toBe(false);
      expect(helper.looksLikeSecretSeed(null)).toBe(false);
      expect(helper.looksLikeSecretSeed(undefined)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // maskKey
  // -----------------------------------------------------------------------

  describe('maskKey', () => {
    it('masks the middle of a StrKey string', () => {
      const key = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234';
      const masked = helper.maskKey(key);

      expect(masked.startsWith('GABCDE')).toBe(true);
      expect(masked.endsWith('34')).toBe(true);
      expect(masked.length).toBe(key.length);
      expect(masked).toContain('*');
    });

    it('uses custom prefix and suffix lengths', () => {
      const key = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234';
      const masked = helper.maskKey(key, 3, 2);

      expect(masked.startsWith('GAB')).toBe(true);
      expect(masked.endsWith('34')).toBe(true);
    });

    it('returns [INVALID] for non-string inputs', () => {
      expect(helper.maskKey(123)).toBe('[INVALID]');
      expect(helper.maskKey(null)).toBe('[INVALID]');
      expect(helper.maskKey(undefined)).toBe('[INVALID]');
    });

    it('returns [REDACTED] for strings that are too short to mask', () => {
      expect(helper.maskKey('GAB')).toBe('[REDACTED]');
    });
  });

  // -----------------------------------------------------------------------
  // Round-trip encoding/decoding
  // -----------------------------------------------------------------------

  describe('round-trip encoding/decoding', () => {
    it('public key round-trip preserves data', () => {
      const original = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) original[i] = i;

      const encoded = helper.encodeEd25519PublicKey(original);
      const decoded = helper.decodeEd25519PublicKey(encoded);

      expect(decoded.equals(original)).toBe(true);
    });

    it('secret seed round-trip preserves data', () => {
      const original = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) original[i] = 31 - i;

      const encoded = helper.encodeEd25519SecretSeed(original);
      const decoded = helper.decodeEd25519SecretSeed(encoded);

      expect(decoded.equals(original)).toBe(true);
    });

    it('pre-auth tx round-trip preserves data', () => {
      const original = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) original[i] = i * 2;

      const encoded = helper.encodePreAuthTx(original);
      const decoded = helper.decodePreAuthTx(encoded);

      expect(decoded.equals(original)).toBe(true);
    });

    it('SHA256 hash round-trip preserves data', () => {
      const original = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) original[i] = 255 - i;

      const encoded = helper.encodeSha256Hash(original);
      const decoded = helper.decodeSha256Hash(encoded);

      expect(decoded.equals(original)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases and adversarial inputs
  // -----------------------------------------------------------------------

  describe('edge cases and adversarial inputs', () => {
    it('handles all-zeros buffer', () => {
      const buffer = Buffer.alloc(32);
      const encoded = helper.encodeEd25519PublicKey(buffer);
      const decoded = helper.decodeEd25519PublicKey(encoded);
      expect(decoded.equals(buffer)).toBe(true);
    });

    it('handles all-0xFF buffer', () => {
      const buffer = Buffer.alloc(32).fill(0xff);
      const encoded = helper.encodeEd25519PublicKey(buffer);
      const decoded = helper.decodeEd25519PublicKey(encoded);
      expect(decoded.equals(buffer)).toBe(true);
    });

    it('rejects StrKey with lowercase prefix', () => {
      expect(helper.isValidEd25519PublicKey('gabc...')).toBe(false);
    });

    it('rejects StrKey with invalid base32 characters', () => {
      expect(helper.isValidEd25519PublicKey('GABC=...')).toBe(false);
    });

    it('rejects StrKey with whitespace', () => {
      expect(helper.isValidEd25519PublicKey('GABC... ')).toBe(false);
    });

    it('does not leak raw key material in error messages', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);
      const corrupted = encoded.slice(0, -1) + 'Z';

      try {
        helper.decodeEd25519PublicKey(corrupted);
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).not.toContain(encoded);
        expect(error.message).not.toContain('0x01');
      }
    });
  });
});
