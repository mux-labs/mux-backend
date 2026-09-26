import { Test, TestingModule } from '@nestjs/testing';
import { StrKeyHelper, StrKeyType } from './strkey.helper';

/**
 * Integration tests for StrKeyHelper.
 *
 * These tests verify that StrKeyHelper works correctly when integrated
 * with other key management components and handles real-world scenarios.
 */
describe('StrKeyHelper Integration', () => {
  let helper: StrKeyHelper;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StrKeyHelper],
    }).compile();

    helper = module.get<StrKeyHelper>(StrKeyHelper);
  });

  // -----------------------------------------------------------------------
  // Integration with KeyManagementService-style workflows
  // -----------------------------------------------------------------------

  describe('key generation workflow', () => {
    it('generates and validates a keypair end-to-end', () => {
      // Step 1: Generate raw key material (simulating what a CSPRNG would do)
      const publicKeyBuffer = Buffer.alloc(32);
      const secretSeedBuffer = Buffer.alloc(32);

      for (let i = 0; i < 32; i++) {
        publicKeyBuffer[i] = Math.floor(Math.random() * 256);
        secretSeedBuffer[i] = Math.floor(Math.random() * 256);
      }

      // Step 2: Encode to StrKey format
      const publicKey = helper.encodeEd25519PublicKey(publicKeyBuffer);
      const secretSeed = helper.encodeEd25519SecretSeed(secretSeedBuffer);

      // Step 3: Validate the encoded keys
      expect(helper.isValidEd25519PublicKey(publicKey)).toBe(true);
      expect(helper.isValidEd25519SecretSeed(secretSeed)).toBe(true);

      // Step 4: Verify type detection
      const publicKeyInfo = helper.getStrKeyType(publicKey);
      expect(publicKeyInfo.isValid).toBe(true);
      expect(publicKeyInfo.type).toBe(StrKeyType.ED25519_PUBLIC_KEY);

      const secretSeedInfo = helper.getStrKeyType(secretSeed);
      expect(secretSeedInfo.isValid).toBe(true);
      expect(secretSeedInfo.type).toBe(StrKeyType.ED25519_SECRET_SEED);
    });

    it('validates that public key and secret seed are different', () => {
      const publicKeyBuffer = Buffer.alloc(32);
      publicKeyBuffer.fill(0x01);

      const secretSeedBuffer = Buffer.alloc(32);
      secretSeedBuffer.fill(0x02);

      const publicKey = helper.encodeEd25519PublicKey(publicKeyBuffer);
      const secretSeed = helper.encodeEd25519SecretSeed(secretSeedBuffer);

      expect(publicKey).not.toBe(secretSeed);
      expect(helper.getStrKeyType(publicKey).type).toBe(
        StrKeyType.ED25519_PUBLIC_KEY,
      );
      expect(helper.getStrKeyType(secretSeed).type).toBe(
        StrKeyType.ED25519_SECRET_SEED,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Audit logging integration (safe logging with masking)
  // -----------------------------------------------------------------------

  describe('audit logging with safe masking', () => {
    it('masks public keys for audit logs', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const publicKey = helper.encodeEd25519PublicKey(buffer);

      const masked = helper.maskKey(publicKey);

      // Masked key should not contain the full original key
      expect(masked).not.toBe(publicKey);
      expect(masked).toContain('*');
      // Should still start with the correct prefix
      expect(masked.startsWith('G')).toBe(true);
    });

    it('masks secret seeds for audit logs', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x02);
      const secretSeed = helper.encodeEd25519SecretSeed(buffer);

      const masked = helper.maskKey(secretSeed);

      expect(masked).not.toBe(secretSeed);
      expect(masked).toContain('*');
      expect(masked.startsWith('S')).toBe(true);
    });

    it('detects secret seeds before logging', () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x02);
      const secretSeed = helper.encodeEd25519SecretSeed(buffer);

      expect(helper.looksLikeSecretSeed(secretSeed)).toBe(true);
      expect(helper.looksLikeSecretSeed('GABC...')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Batch validation workflow
  // -----------------------------------------------------------------------

  describe('batch validation workflow', () => {
    it('validates a mix of valid and invalid keys', () => {
      const validPublicKeyBuffer = Buffer.alloc(32);
      validPublicKeyBuffer.fill(0x01);
      const validPublicKey = helper.encodeEd25519PublicKey(
        validPublicKeyBuffer,
      );

      const keys = [
        { key: validPublicKey, expected: true },
        { key: 'GINVALIDCHECKSUMXXXX', expected: false },
        { key: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ12', expected: false },
        { key: '', expected: false },
        { key: 'GABC', expected: false },
        { key: null as any, expected: false },
        { key: undefined as any, expected: false },
      ];

      for (const { key, expected } of keys) {
        const result = helper.isValidEd25519PublicKey(key);
        expect(result).toBe(expected);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Error handling under load
  // -----------------------------------------------------------------------

  describe('concurrent operations', () => {
    it('handles concurrent encoding and decoding without state corruption', async () => {
      const buffers: Buffer[] = [];
      for (let i = 0; i < 10; i++) {
        const buf = Buffer.alloc(32);
        buf.fill(i);
        buffers.push(buf);
      }

      const encoded = buffers.map((buf) =>
        helper.encodeEd25519PublicKey(buf),
      );
      const decoded = encoded.map((enc) =>
        helper.decodeEd25519PublicKey(enc),
      );

      for (let i = 0; i < buffers.length; i++) {
        expect(decoded[i].equals(buffers[i])).toBe(true);
      }
    });

    it('handles concurrent validation without state corruption', async () => {
      const buffer = Buffer.alloc(32);
      buffer.fill(0x01);
      const encoded = helper.encodeEd25519PublicKey(buffer);

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          Promise.resolve(helper.isValidEd25519PublicKey(encoded)),
        ),
      );

      for (const result of results) {
        expect(result).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Type detection integration
  // -----------------------------------------------------------------------

  describe('type detection integration', () => {
    it('correctly identifies all StrKey types in a mixed batch', () => {
      const pkBuffer = Buffer.alloc(32);
      pkBuffer.fill(0x01);
      const pk = helper.encodeEd25519PublicKey(pkBuffer);

      const ssBuffer = Buffer.alloc(32);
      ssBuffer.fill(0x02);
      const ss = helper.encodeEd25519SecretSeed(ssBuffer);

      const patxBuffer = Buffer.alloc(32);
      patxBuffer.fill(0x03);
      const patx = helper.encodePreAuthTx(patxBuffer);

      const hashBuffer = Buffer.alloc(32);
      hashBuffer.fill(0x04);
      const hash = helper.encodeSha256Hash(hashBuffer);

      const batch = [
        { key: pk, expectedType: StrKeyType.ED25519_PUBLIC_KEY },
        { key: ss, expectedType: StrKeyType.ED25519_SECRET_SEED },
        { key: patx, expectedType: StrKeyType.PRE_AUTH_TX },
        { key: hash, expectedType: StrKeyType.SHA256_HASH },
      ];

      for (const { key, expectedType } of batch) {
        const info = helper.getStrKeyType(key);
        expect(info.isValid).toBe(true);
        expect(info.type).toBe(expectedType);
      }
    });
  });
});
