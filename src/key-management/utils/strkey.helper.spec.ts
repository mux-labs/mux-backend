import { StrKeyHelper } from './strkey.helper';
import { Keypair } from 'stellar-sdk';

describe('StrKeyHelper', () => {
  let testKeypair: Keypair;
  let testPublicKeyBuffer: Buffer;
  let testSecretSeedBuffer: Buffer;

  beforeEach(() => {
    // Generate a test keypair for consistent testing
    testKeypair = Keypair.random();
    // Extract raw buffers
    testPublicKeyBuffer = testKeypair.rawPublicKey();
    testSecretSeedBuffer = testKeypair.rawSecretKey();
  });

  describe('encodeEd25519PublicKey', () => {
    it('should encode a valid 32-byte public key buffer', () => {
      const encoded = StrKeyHelper.encodeEd25519PublicKey(testPublicKeyBuffer);

      expect(encoded).toBeDefined();
      expect(typeof encoded).toBe('string');
      expect(encoded.startsWith('G')).toBe(true);
      expect(encoded.length).toBe(56);
    });

    it('should throw error for non-Buffer input', () => {
      expect(() => {
        StrKeyHelper.encodeEd25519PublicKey('not a buffer' as any);
      }).toThrow('Public key must be a Buffer');
    });

    it('should throw error for wrong length buffer', () => {
      const wrongLength = Buffer.alloc(16); // Should be 32 bytes

      expect(() => {
        StrKeyHelper.encodeEd25519PublicKey(wrongLength);
      }).toThrow('Invalid public key length: expected 32 bytes, got 16');
    });

    it('should produce consistent encoding for same input', () => {
      const encoded1 = StrKeyHelper.encodeEd25519PublicKey(testPublicKeyBuffer);
      const encoded2 = StrKeyHelper.encodeEd25519PublicKey(testPublicKeyBuffer);

      expect(encoded1).toBe(encoded2);
    });
  });

  describe('encodeEd25519SecretSeed', () => {
    it('should encode a valid 32-byte secret seed buffer', () => {
      const encoded = StrKeyHelper.encodeEd25519SecretSeed(testSecretSeedBuffer);

      expect(encoded).toBeDefined();
      expect(typeof encoded).toBe('string');
      expect(encoded.startsWith('S')).toBe(true);
      expect(encoded.length).toBe(56);
    });

    it('should throw error for non-Buffer input', () => {
      expect(() => {
        StrKeyHelper.encodeEd25519SecretSeed('not a buffer' as any);
      }).toThrow('Secret seed must be a Buffer');
    });

    it('should throw error for wrong length buffer', () => {
      const wrongLength = Buffer.alloc(64); // Should be 32 bytes

      expect(() => {
        StrKeyHelper.encodeEd25519SecretSeed(wrongLength);
      }).toThrow('Invalid secret seed length: expected 32 bytes, got 64');
    });

    it('should produce consistent encoding for same input', () => {
      const encoded1 = StrKeyHelper.encodeEd25519SecretSeed(testSecretSeedBuffer);
      const encoded2 = StrKeyHelper.encodeEd25519SecretSeed(testSecretSeedBuffer);

      expect(encoded1).toBe(encoded2);
    });
  });

  describe('decodeEd25519PublicKey', () => {
    it('should decode a valid Stellar public key', () => {
      const encoded = testKeypair.publicKey();
      const decoded = StrKeyHelper.decodeEd25519PublicKey(encoded);

      expect(decoded).toBeDefined();
      expect(Buffer.isBuffer(decoded)).toBe(true);
      expect(decoded.length).toBe(32);
      expect(decoded).toEqual(testPublicKeyBuffer);
    });

    it('should throw error for non-string input', () => {
      expect(() => {
        StrKeyHelper.decodeEd25519PublicKey(123 as any);
      }).toThrow('Encoded key must be a string');
    });

    it('should throw error for key not starting with G', () => {
      expect(() => {
        StrKeyHelper.decodeEd25519PublicKey('SABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQR');
      }).toThrow("Invalid public key format: expected key to start with 'G'");
    });

    it('should throw error for invalid key format', () => {
      expect(() => {
        StrKeyHelper.decodeEd25519PublicKey('G1NVALIDKEY');
      }).toThrow('Failed to decode Ed25519 public key');
    });

    it('should round-trip encode/decode correctly', () => {
      const encoded = StrKeyHelper.encodeEd25519PublicKey(testPublicKeyBuffer);
      const decoded = StrKeyHelper.decodeEd25519PublicKey(encoded);

      expect(decoded).toEqual(testPublicKeyBuffer);
    });
  });

  describe('decodeEd25519SecretSeed', () => {
    it('should decode a valid Stellar secret seed', () => {
      const encoded = testKeypair.secret();
      const decoded = StrKeyHelper.decodeEd25519SecretSeed(encoded);

      expect(decoded).toBeDefined();
      expect(Buffer.isBuffer(decoded)).toBe(true);
      expect(decoded.length).toBe(32);
      expect(decoded).toEqual(testSecretSeedBuffer);
    });

    it('should throw error for non-string input', () => {
      expect(() => {
        StrKeyHelper.decodeEd25519SecretSeed(Buffer.from('test') as any);
      }).toThrow('Encoded seed must be a string');
    });

    it('should throw error for seed not starting with S', () => {
      expect(() => {
        StrKeyHelper.decodeEd25519SecretSeed('GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQR');
      }).toThrow("Invalid secret seed format: expected seed to start with 'S'");
    });

    it('should throw error for invalid seed format', () => {
      expect(() => {
        StrKeyHelper.decodeEd25519SecretSeed('S1NVALIDSEED');
      }).toThrow('Failed to decode Ed25519 secret seed');
    });

    it('should round-trip encode/decode correctly', () => {
      const encoded = StrKeyHelper.encodeEd25519SecretSeed(testSecretSeedBuffer);
      const decoded = StrKeyHelper.decodeEd25519SecretSeed(encoded);

      expect(decoded).toEqual(testSecretSeedBuffer);
    });
  });

  describe('isValidEd25519PublicKey', () => {
    it('should return true for valid public key', () => {
      const validKey = testKeypair.publicKey();

      expect(StrKeyHelper.isValidEd25519PublicKey(validKey)).toBe(true);
    });

    it('should return false for invalid public key', () => {
      expect(StrKeyHelper.isValidEd25519PublicKey('GINVALIDKEY')).toBe(false);
    });

    it('should return false for secret seed', () => {
      const secretSeed = testKeypair.secret();

      expect(StrKeyHelper.isValidEd25519PublicKey(secretSeed)).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(StrKeyHelper.isValidEd25519PublicKey(123 as any)).toBe(false);
      expect(StrKeyHelper.isValidEd25519PublicKey(null as any)).toBe(false);
      expect(StrKeyHelper.isValidEd25519PublicKey(undefined as any)).toBe(false);
    });
  });

  describe('isValidEd25519SecretSeed', () => {
    it('should return true for valid secret seed', () => {
      const validSeed = testKeypair.secret();

      expect(StrKeyHelper.isValidEd25519SecretSeed(validSeed)).toBe(true);
    });

    it('should return false for invalid secret seed', () => {
      expect(StrKeyHelper.isValidEd25519SecretSeed('SINVALIDSEED')).toBe(false);
    });

    it('should return false for public key', () => {
      const publicKey = testKeypair.publicKey();

      expect(StrKeyHelper.isValidEd25519SecretSeed(publicKey)).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(StrKeyHelper.isValidEd25519SecretSeed([] as any)).toBe(false);
      expect(StrKeyHelper.isValidEd25519SecretSeed(null as any)).toBe(false);
      expect(StrKeyHelper.isValidEd25519SecretSeed(undefined as any)).toBe(false);
    });
  });

  describe('encodePreAuthTx', () => {
    it('should encode a 32-byte transaction hash', () => {
      const hash = Buffer.alloc(32).fill(0x42);
      const encoded = StrKeyHelper.encodePreAuthTx(hash);

      expect(encoded).toBeDefined();
      expect(typeof encoded).toBe('string');
      expect(encoded.startsWith('T')).toBe(true);
    });

    it('should throw error for non-Buffer input', () => {
      expect(() => {
        StrKeyHelper.encodePreAuthTx('not a buffer' as any);
      }).toThrow('Transaction hash must be a Buffer');
    });

    it('should throw error for wrong length', () => {
      const wrongLength = Buffer.alloc(16);

      expect(() => {
        StrKeyHelper.encodePreAuthTx(wrongLength);
      }).toThrow('Invalid hash length: expected 32 bytes, got 16');
    });
  });

  describe('decodePreAuthTx', () => {
    it('should decode a valid pre-auth tx hash', () => {
      const hash = Buffer.alloc(32).fill(0x42);
      const encoded = StrKeyHelper.encodePreAuthTx(hash);
      const decoded = StrKeyHelper.decodePreAuthTx(encoded);

      expect(decoded).toEqual(hash);
    });

    it('should throw error for non-string input', () => {
      expect(() => {
        StrKeyHelper.decodePreAuthTx(12345 as any);
      }).toThrow('Encoded transaction must be a string');
    });

    it('should throw error for invalid format', () => {
      expect(() => {
        StrKeyHelper.decodePreAuthTx('TINVALIDHASH');
      }).toThrow('Failed to decode pre-authorized transaction');
    });
  });

  describe('encodeSha256Hash', () => {
    it('should encode a 32-byte SHA256 hash', () => {
      const hash = Buffer.alloc(32).fill(0xAB);
      const encoded = StrKeyHelper.encodeSha256Hash(hash);

      expect(encoded).toBeDefined();
      expect(typeof encoded).toBe('string');
      expect(encoded.startsWith('X')).toBe(true);
    });

    it('should throw error for non-Buffer input', () => {
      expect(() => {
        StrKeyHelper.encodeSha256Hash('not a buffer' as any);
      }).toThrow('Hash must be a Buffer');
    });

    it('should throw error for wrong length', () => {
      const wrongLength = Buffer.alloc(20);

      expect(() => {
        StrKeyHelper.encodeSha256Hash(wrongLength);
      }).toThrow('Invalid hash length: expected 32 bytes, got 20');
    });
  });

  describe('decodeSha256Hash', () => {
    it('should decode a valid SHA256 hash', () => {
      const hash = Buffer.alloc(32).fill(0xAB);
      const encoded = StrKeyHelper.encodeSha256Hash(hash);
      const decoded = StrKeyHelper.decodeSha256Hash(encoded);

      expect(decoded).toEqual(hash);
    });

    it('should throw error for non-string input', () => {
      expect(() => {
        StrKeyHelper.decodeSha256Hash({} as any);
      }).toThrow('Encoded hash must be a string');
    });

    it('should throw error for invalid format', () => {
      expect(() => {
        StrKeyHelper.decodeSha256Hash('XINVALIDHASH');
      }).toThrow('Failed to decode SHA256 hash');
    });
  });

  describe('getStrKeyType', () => {
    it('should identify valid public key', () => {
      const publicKey = testKeypair.publicKey();
      const result = StrKeyHelper.getStrKeyType(publicKey);

      expect(result.isValid).toBe(true);
      expect(result.type).toBe('publicKey');
    });

    it('should identify valid secret seed', () => {
      const secretSeed = testKeypair.secret();
      const result = StrKeyHelper.getStrKeyType(secretSeed);

      expect(result.isValid).toBe(true);
      expect(result.type).toBe('secretSeed');
    });

    it('should identify pre-auth tx', () => {
      const hash = Buffer.alloc(32).fill(0x42);
      const encoded = StrKeyHelper.encodePreAuthTx(hash);
      const result = StrKeyHelper.getStrKeyType(encoded);

      expect(result.isValid).toBe(true);
      expect(result.type).toBe('preAuthTx');
    });

    it('should identify SHA256 hash', () => {
      const hash = Buffer.alloc(32).fill(0xAB);
      const encoded = StrKeyHelper.encodeSha256Hash(hash);
      const result = StrKeyHelper.getStrKeyType(encoded);

      expect(result.isValid).toBe(true);
      expect(result.type).toBe('sha256Hash');
    });

    it('should return unknown for invalid string', () => {
      const result = StrKeyHelper.getStrKeyType('INVALIDKEY');

      expect(result.isValid).toBe(false);
      expect(result.type).toBe('unknown');
    });

    it('should return unknown for non-string input', () => {
      const result = StrKeyHelper.getStrKeyType(12345 as any);

      expect(result.isValid).toBe(false);
      expect(result.type).toBe('unknown');
    });
  });

  describe('looksLikeSecretSeed', () => {
    it('should return true for valid secret seed format', () => {
      const secretSeed = testKeypair.secret();

      expect(StrKeyHelper.looksLikeSecretSeed(secretSeed)).toBe(true);
    });

    it('should return true for S-prefixed 56-char string even if invalid', () => {
      const fakeSeed = 'S' + '1'.repeat(55);

      expect(StrKeyHelper.looksLikeSecretSeed(fakeSeed)).toBe(true);
    });

    it('should return false for public key', () => {
      const publicKey = testKeypair.publicKey();

      expect(StrKeyHelper.looksLikeSecretSeed(publicKey)).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(StrKeyHelper.looksLikeSecretSeed(123)).toBe(false);
      expect(StrKeyHelper.looksLikeSecretSeed(null)).toBe(false);
      expect(StrKeyHelper.looksLikeSecretSeed(undefined)).toBe(false);
      expect(StrKeyHelper.looksLikeSecretSeed({})).toBe(false);
    });

    it('should return false for short S-prefixed string', () => {
      expect(StrKeyHelper.looksLikeSecretSeed('S123')).toBe(false);
    });
  });

  describe('maskKey', () => {
    it('should mask a key showing only prefix and suffix', () => {
      const key = testKeypair.publicKey();
      const masked = StrKeyHelper.maskKey(key);

      expect(masked).toContain('*');
      expect(masked.startsWith(key.substring(0, 4))).toBe(true);
      expect(masked.endsWith(key.substring(key.length - 4))).toBe(true);
    });

    it('should handle custom prefix and suffix lengths', () => {
      const key = testKeypair.publicKey();
      const masked = StrKeyHelper.maskKey(key, 6, 6);

      expect(masked.startsWith(key.substring(0, 6))).toBe(true);
      expect(masked.endsWith(key.substring(key.length - 6))).toBe(true);
    });

    it('should return *** for very short keys', () => {
      const shortKey = 'ABC';
      const masked = StrKeyHelper.maskKey(shortKey, 4, 4);

      expect(masked).toBe('***');
    });

    it('should limit asterisk length to 20', () => {
      const longKey = 'G' + 'A'.repeat(100);
      const masked = StrKeyHelper.maskKey(longKey, 4, 4);

      const asteriskCount = (masked.match(/\*/g) || []).length;
      expect(asteriskCount).toBeLessThanOrEqual(20);
    });

    it('should handle secret seeds safely', () => {
      const secretSeed = testKeypair.secret();
      const masked = StrKeyHelper.maskKey(secretSeed);

      // Should not expose the full secret
      expect(masked).not.toBe(secretSeed);
      expect(masked).toContain('*');
      expect(masked.length).toBeLessThan(secretSeed.length);
    });
  });

  describe('Integration - Full Key Lifecycle', () => {
    it('should handle complete encode/decode cycle for public key', () => {
      const rawKey = testPublicKeyBuffer;
      const encoded = StrKeyHelper.encodeEd25519PublicKey(rawKey);
      const decoded = StrKeyHelper.decodeEd25519PublicKey(encoded);

      expect(decoded).toEqual(rawKey);
      expect(StrKeyHelper.isValidEd25519PublicKey(encoded)).toBe(true);
    });

    it('should handle complete encode/decode cycle for secret seed', () => {
      const rawSeed = testSecretSeedBuffer;
      const encoded = StrKeyHelper.encodeEd25519SecretSeed(rawSeed);
      const decoded = StrKeyHelper.decodeEd25519SecretSeed(encoded);

      expect(decoded).toEqual(rawSeed);
      expect(StrKeyHelper.isValidEd25519SecretSeed(encoded)).toBe(true);
    });

    it('should correctly identify and validate different key types', () => {
      const publicKey = testKeypair.publicKey();
      const secretSeed = testKeypair.secret();
      const hash = Buffer.alloc(32);
      const preAuthTx = StrKeyHelper.encodePreAuthTx(hash);
      const sha256Hash = StrKeyHelper.encodeSha256Hash(hash);

      // Each should be identified correctly
      expect(StrKeyHelper.getStrKeyType(publicKey).type).toBe('publicKey');
      expect(StrKeyHelper.getStrKeyType(secretSeed).type).toBe('secretSeed');
      expect(StrKeyHelper.getStrKeyType(preAuthTx).type).toBe('preAuthTx');
      expect(StrKeyHelper.getStrKeyType(sha256Hash).type).toBe('sha256Hash');

      // Validation should not cross-validate
      expect(StrKeyHelper.isValidEd25519PublicKey(secretSeed)).toBe(false);
      expect(StrKeyHelper.isValidEd25519SecretSeed(publicKey)).toBe(false);
    });
  });

  describe('Security - Edge Cases', () => {
    it('should handle malformed input gracefully', () => {
      const malformedInputs = [
        '',
        'G',
        'S',
        'GSHORT',
        'TOOLONGKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        'G' + '\x00'.repeat(55),
        null,
        undefined,
        {},
        [],
        123,
      ];

      malformedInputs.forEach((input) => {
        expect(() => {
          if (typeof input === 'string') {
            StrKeyHelper.isValidEd25519PublicKey(input);
            StrKeyHelper.isValidEd25519SecretSeed(input);
          }
        }).not.toThrow();
      });
    });

    it('should not expose sensitive data in error messages', () => {
      const secretSeed = testKeypair.secret();

      try {
        // Try to decode as public key (wrong type)
        StrKeyHelper.decodeEd25519PublicKey(secretSeed);
        fail('Should have thrown error');
      } catch (error) {
        // Error message should not contain the actual secret
        expect(error.message).not.toContain(secretSeed.substring(5));
      }
    });
  });
});
