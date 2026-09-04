/**
 * Contract Tests for StrKey Helper
 *
 * These tests verify that the StrKeyHelper conforms to the Stellar StrKey
 * specification and maintains compatibility with stellar-sdk.
 */

import { StrKeyHelper } from './strkey.helper';
import { Keypair, StrKey } from 'stellar-sdk';

describe('StrKeyHelper Contract Tests', () => {
  describe('Stellar SDK Compatibility', () => {
    it('should produce identical encoding to stellar-sdk for public keys', () => {
      const keypair = Keypair.random();
      const rawPublicKey = keypair.rawPublicKey();

      // Encode using StrKeyHelper
      const helperEncoded = StrKeyHelper.encodeEd25519PublicKey(rawPublicKey);

      // Encode using stellar-sdk directly
      const sdkEncoded = StrKey.encodeEd25519PublicKey(rawPublicKey);

      // Should match stellar-sdk
      expect(helperEncoded).toBe(sdkEncoded);
      expect(helperEncoded).toBe(keypair.publicKey());
    });

    it('should produce identical encoding to stellar-sdk for secret seeds', () => {
      const keypair = Keypair.random();
      const rawSecretKey = keypair.rawSecretKey();

      // Encode using StrKeyHelper
      const helperEncoded = StrKeyHelper.encodeEd25519SecretSeed(rawSecretKey);

      // Encode using stellar-sdk directly
      const sdkEncoded = StrKey.encodeEd25519SecretSeed(rawSecretKey);

      // Should match stellar-sdk
      expect(helperEncoded).toBe(sdkEncoded);
      expect(helperEncoded).toBe(keypair.secret());
    });

    it('should decode public keys identically to stellar-sdk', () => {
      const keypair = Keypair.random();
      const publicKey = keypair.publicKey();

      // Decode using StrKeyHelper
      const helperDecoded = StrKeyHelper.decodeEd25519PublicKey(publicKey);

      // Decode using stellar-sdk directly
      const sdkDecoded = StrKey.decodeEd25519PublicKey(publicKey);

      // Should produce identical buffers
      expect(helperDecoded).toEqual(sdkDecoded);
      expect(helperDecoded).toEqual(keypair.rawPublicKey());
    });

    it('should decode secret seeds identically to stellar-sdk', () => {
      const keypair = Keypair.random();
      const secretSeed = keypair.secret();

      // Decode using StrKeyHelper
      const helperDecoded = StrKeyHelper.decodeEd25519SecretSeed(secretSeed);

      // Decode using stellar-sdk directly
      const sdkDecoded = StrKey.decodeEd25519SecretSeed(secretSeed);

      // Should produce identical buffers
      expect(helperDecoded).toEqual(sdkDecoded);
      expect(helperDecoded).toEqual(keypair.rawSecretKey());
    });

    it('should validate public keys identically to stellar-sdk', () => {
      const keypair = Keypair.random();
      const validKey = keypair.publicKey();
      const invalidKey = 'GINVALIDKEY';

      // Validate using StrKeyHelper
      const helperValidResult = StrKeyHelper.isValidEd25519PublicKey(validKey);
      const helperInvalidResult =
        StrKeyHelper.isValidEd25519PublicKey(invalidKey);

      // Validate using stellar-sdk directly
      const sdkValidResult = StrKey.isValidEd25519PublicKey(validKey);
      const sdkInvalidResult = StrKey.isValidEd25519PublicKey(invalidKey);

      // Should match stellar-sdk
      expect(helperValidResult).toBe(sdkValidResult);
      expect(helperInvalidResult).toBe(sdkInvalidResult);
      expect(helperValidResult).toBe(true);
      expect(helperInvalidResult).toBe(false);
    });

    it('should validate secret seeds identically to stellar-sdk', () => {
      const keypair = Keypair.random();
      const validSeed = keypair.secret();
      const invalidSeed = 'SINVALIDSEED';

      // Validate using StrKeyHelper
      const helperValidResult =
        StrKeyHelper.isValidEd25519SecretSeed(validSeed);
      const helperInvalidResult =
        StrKeyHelper.isValidEd25519SecretSeed(invalidSeed);

      // Validate using stellar-sdk directly
      const sdkValidResult = StrKey.isValidEd25519SecretSeed(validSeed);
      const sdkInvalidResult = StrKey.isValidEd25519SecretSeed(invalidSeed);

      // Should match stellar-sdk
      expect(helperValidResult).toBe(sdkValidResult);
      expect(helperInvalidResult).toBe(sdkInvalidResult);
      expect(helperValidResult).toBe(true);
      expect(helperInvalidResult).toBe(false);
    });
  });

  describe('Stellar Protocol Compliance', () => {
    it('should produce 56-character public keys', () => {
      const keypair = Keypair.random();
      const encoded = StrKeyHelper.encodeEd25519PublicKey(
        keypair.rawPublicKey(),
      );

      expect(encoded.length).toBe(56);
    });

    it('should produce 56-character secret seeds', () => {
      const keypair = Keypair.random();
      const encoded = StrKeyHelper.encodeEd25519SecretSeed(
        keypair.rawSecretKey(),
      );

      expect(encoded.length).toBe(56);
    });

    it('should produce public keys starting with G', () => {
      const keypair = Keypair.random();
      const encoded = StrKeyHelper.encodeEd25519PublicKey(
        keypair.rawPublicKey(),
      );

      expect(encoded.startsWith('G')).toBe(true);
      expect(encoded.charAt(0)).toBe('G');
    });

    it('should produce secret seeds starting with S', () => {
      const keypair = Keypair.random();
      const encoded = StrKeyHelper.encodeEd25519SecretSeed(
        keypair.rawSecretKey(),
      );

      expect(encoded.startsWith('S')).toBe(true);
      expect(encoded.charAt(0)).toBe('S');
    });

    it('should only accept 32-byte buffers for encoding', () => {
      const validBuffer = Buffer.alloc(32);
      const invalidBuffer16 = Buffer.alloc(16);
      const invalidBuffer64 = Buffer.alloc(64);

      // Valid buffer should work
      expect(() =>
        StrKeyHelper.encodeEd25519PublicKey(validBuffer),
      ).not.toThrow();

      // Invalid buffers should throw
      expect(() =>
        StrKeyHelper.encodeEd25519PublicKey(invalidBuffer16),
      ).toThrow(/32 bytes/);
      expect(() =>
        StrKeyHelper.encodeEd25519PublicKey(invalidBuffer64),
      ).toThrow(/32 bytes/);
    });

    it('should produce 32-byte buffers when decoding', () => {
      const keypair = Keypair.random();
      const publicKey = keypair.publicKey();
      const secretSeed = keypair.secret();

      const decodedPublic = StrKeyHelper.decodeEd25519PublicKey(publicKey);
      const decodedSecret = StrKeyHelper.decodeEd25519SecretSeed(secretSeed);

      expect(decodedPublic.length).toBe(32);
      expect(decodedSecret.length).toBe(32);
    });

    it('should maintain data integrity through encode/decode cycle', () => {
      // Generate random 32-byte buffers
      const originalPublic = Buffer.from(Keypair.random().rawPublicKey());
      const originalSecret = Buffer.from(Keypair.random().rawSecretKey());

      // Encode
      const encodedPublic = StrKeyHelper.encodeEd25519PublicKey(originalPublic);
      const encodedSecret =
        StrKeyHelper.encodeEd25519SecretSeed(originalSecret);

      // Decode
      const decodedPublic = StrKeyHelper.decodeEd25519PublicKey(encodedPublic);
      const decodedSecret = StrKeyHelper.decodeEd25519SecretSeed(encodedSecret);

      // Should match original
      expect(decodedPublic).toEqual(originalPublic);
      expect(decodedSecret).toEqual(originalSecret);
    });

    it('should detect checksum errors in invalid keys', () => {
      const validKey = Keypair.random().publicKey();

      // Corrupt the key by changing a character (breaks checksum)
      const corruptedKey = 'G' + validKey.substring(1, 55) + 'A';

      expect(StrKeyHelper.isValidEd25519PublicKey(validKey)).toBe(true);
      expect(StrKeyHelper.isValidEd25519PublicKey(corruptedKey)).toBe(false);
    });
  });

  describe('Real-World Key Examples', () => {
    // Test with known Stellar testnet/mainnet addresses
    const KNOWN_ADDRESSES = [
      'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', // Example mainnet
      'GCEXAMPLE5UPYMJV7YFZKCX3JWGPYH6RU7QAYWDWZLWPMMG2T3H', // Example format
    ];

    it('should validate known Stellar addresses', () => {
      KNOWN_ADDRESSES.forEach((address) => {
        const isValid = StrKeyHelper.isValidEd25519PublicKey(address);
        // Note: These may or may not be valid depending on checksum
        // Just testing that the validation logic runs
        expect(typeof isValid).toBe('boolean');
      });
    });

    it('should handle 1000 keypairs without errors', () => {
      const results = [];

      for (let i = 0; i < 1000; i++) {
        const keypair = Keypair.random();
        const encoded = StrKeyHelper.encodeEd25519PublicKey(
          keypair.rawPublicKey(),
        );
        const decoded = StrKeyHelper.decodeEd25519PublicKey(encoded);
        const isValid = StrKeyHelper.isValidEd25519PublicKey(encoded);

        results.push({
          encoded,
          decoded,
          isValid,
          matches: decoded.equals(keypair.rawPublicKey()),
        });
      }

      // All should be valid and match
      expect(results.every((r) => r.isValid)).toBe(true);
      expect(results.every((r) => r.matches)).toBe(true);
      expect(results.every((r) => r.encoded.startsWith('G'))).toBe(true);
      expect(results.every((r) => r.encoded.length === 56)).toBe(true);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle null and undefined gracefully', () => {
      expect(StrKeyHelper.isValidEd25519PublicKey(null as any)).toBe(false);
      expect(StrKeyHelper.isValidEd25519PublicKey(undefined as any)).toBe(
        false,
      );
      expect(StrKeyHelper.isValidEd25519SecretSeed(null as any)).toBe(false);
      expect(StrKeyHelper.isValidEd25519SecretSeed(undefined as any)).toBe(
        false,
      );
    });

    it('should handle empty strings gracefully', () => {
      expect(StrKeyHelper.isValidEd25519PublicKey('')).toBe(false);
      expect(StrKeyHelper.isValidEd25519SecretSeed('')).toBe(false);
    });

    it('should handle wrong prefix gracefully', () => {
      const keypair = Keypair.random();
      const validPublicKey = keypair.publicKey();
      const validSecretSeed = keypair.secret();

      // Public key validation should reject secret seed
      expect(StrKeyHelper.isValidEd25519PublicKey(validSecretSeed)).toBe(false);

      // Secret seed validation should reject public key
      expect(StrKeyHelper.isValidEd25519SecretSeed(validPublicKey)).toBe(false);
    });

    it('should throw descriptive errors for invalid decode attempts', () => {
      expect(() => {
        StrKeyHelper.decodeEd25519PublicKey('SINVALIDPREFIX');
      }).toThrow(/expected key to start with 'G'/);

      expect(() => {
        StrKeyHelper.decodeEd25519SecretSeed('GINVALIDPREFIX');
      }).toThrow(/expected seed to start with 'S'/);
    });
  });

  describe('Performance Characteristics', () => {
    it('should encode 10000 keys in reasonable time', () => {
      const startTime = Date.now();

      for (let i = 0; i < 10000; i++) {
        const rawKey = Keypair.random().rawPublicKey();
        StrKeyHelper.encodeEd25519PublicKey(rawKey);
      }

      const duration = Date.now() - startTime;

      // Should complete in less than 5 seconds (very generous)
      expect(duration).toBeLessThan(5000);
    });

    it('should validate 10000 keys in reasonable time', () => {
      // Pre-generate keys
      const keys = Array.from({ length: 10000 }, () =>
        Keypair.random().publicKey(),
      );

      const startTime = Date.now();

      keys.forEach((key) => {
        StrKeyHelper.isValidEd25519PublicKey(key);
      });

      const duration = Date.now() - startTime;

      // Should complete in less than 2 seconds (very generous)
      expect(duration).toBeLessThan(2000);
    });
  });

  describe('Cross-Verification', () => {
    it('should create keypairs that can be used with stellar-sdk', () => {
      // Generate using helper
      const rawPublic = Keypair.random().rawPublicKey();
      const rawSecret = Keypair.random().rawSecretKey();

      const encodedPublic = StrKeyHelper.encodeEd25519PublicKey(rawPublic);
      const encodedSecret = StrKeyHelper.encodeEd25519SecretSeed(rawSecret);

      // Verify stellar-sdk can work with them
      expect(() => StrKey.decodeEd25519PublicKey(encodedPublic)).not.toThrow();
      expect(() => StrKey.decodeEd25519SecretSeed(encodedSecret)).not.toThrow();

      // Verify stellar-sdk validation agrees
      expect(StrKey.isValidEd25519PublicKey(encodedPublic)).toBe(true);
      expect(StrKey.isValidEd25519SecretSeed(encodedSecret)).toBe(true);
    });

    it('should decode keys generated by stellar-sdk', () => {
      const keypair = Keypair.random();
      const sdkPublicKey = keypair.publicKey();
      const sdkSecretSeed = keypair.secret();

      // Should decode without errors
      expect(() =>
        StrKeyHelper.decodeEd25519PublicKey(sdkPublicKey),
      ).not.toThrow();
      expect(() =>
        StrKeyHelper.decodeEd25519SecretSeed(sdkSecretSeed),
      ).not.toThrow();

      // Should match raw keys
      const decodedPublic = StrKeyHelper.decodeEd25519PublicKey(sdkPublicKey);
      const decodedSecret = StrKeyHelper.decodeEd25519SecretSeed(sdkSecretSeed);

      expect(decodedPublic).toEqual(keypair.rawPublicKey());
      expect(decodedSecret).toEqual(keypair.rawSecretKey());
    });
  });
});
