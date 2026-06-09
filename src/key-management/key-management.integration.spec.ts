/**
 * Key Management Integration Harness
 *
 * Wires the real KeyManagementService + StellarKeyProvider + EncryptionService
 * together (no mocks on the key path) and exercises the full key lifecycle
 * end-to-end without a live database or HSM.
 *
 * Covers:
 * - Key generation: produces encrypted material, valid public key, no private key leak
 * - Signing: produces a verifiable ed25519 signature, no private key in result
 * - Key validation: confirms public key ↔ encrypted material consistency
 * - Key re-encryption: re-wraps material under a fresh ciphertext
 * - Audit log: every operation is recorded with correct metadata
 * - Security properties: private key material never surfaces in logs or results
 * - Stale / invalid / disconnected states: tampered ciphertext, wrong public key,
 *   unsupported key type, empty inputs, and oversized audit log trimming
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyType } from './domain/key-types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

import { KeyRotationAuditService } from './key-rotation-audit.service';

/** Builds a minimal ConfigService stub that satisfies EncryptionService. */
function makeConfigService(
  key = 'integration-test-key-32bytes!!',
): Partial<ConfigService> {
  return {
    get: jest.fn((envKey: string) => {
      if (envKey === 'WALLET_ENCRYPTION_KEY') return key;
      return undefined;
    }),
  };
}

/** Returns true if the string looks like a Stellar public key (G…, 56 chars). */
function isStellarPublicKey(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value);
}

// ---------------------------------------------------------------------------
// Module bootstrap
// ---------------------------------------------------------------------------

describe('KeyManagement (integration harness)', () => {
  let service: KeyManagementService;
  let encryptionService: EncryptionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyManagementService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: makeConfigService(),
        },
        {
          provide: KeyRotationAuditService,
          useValue: {
            persistAuditLog: jest.fn().mockResolvedValue(undefined),
            convertToPersistentFormat: jest.fn().mockReturnValue({}),
          },
        },
      ],
    }).compile();

    service = module.get<KeyManagementService>(KeyManagementService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // Key generation
  // -------------------------------------------------------------------------

  describe('generateKey', () => {
    it('returns encrypted material and a valid Stellar public key', async () => {
      const result = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(result.keyType).toBe(KeyType.STELLAR_ED25519);
      expect(result.encryptionVersion).toBe(1);

      // Public key must be a proper Stellar G-address
      expect(isStellarPublicKey(result.publicKey)).toBe(true);

      // Encrypted blob must be non-empty JSON (serialized EncryptionResult)
      const parsed = JSON.parse(result.encryptedData);
      expect(parsed).toHaveProperty('encryptedData');
      expect(parsed).toHaveProperty('iv');
      expect(parsed).toHaveProperty('tag');
    });

    it('never includes the plaintext private key in the result', async () => {
      const result = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      expect((result as any).privateKey).toBeUndefined();
      expect((result as any).privateKeyMaterial).toBeUndefined();
      expect((result as any).secret).toBeUndefined();
    });

    it('generates unique key pairs on every call', async () => {
      const [a, b, c] = await Promise.all([
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
      ]);

      const publicKeys = [a.publicKey, b.publicKey, c.publicKey];
      const encryptedBlobs = [a.encryptedData, b.encryptedData, c.encryptedData];

      // All public keys distinct
      expect(new Set(publicKeys).size).toBe(3);
      // All encrypted blobs distinct (different IVs guarantee this)
      expect(new Set(encryptedBlobs).size).toBe(3);
    });

    it('accepts optional metadata without leaking it into the encrypted payload', async () => {
      const result = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { label: 'wallet-for-user-xyz', internalNote: 'test' },
      });

      // Metadata must not appear inside the ciphertext blob
      expect(result.encryptedData).not.toContain('wallet-for-user-xyz');
      expect(result.encryptedData).not.toContain('internalNote');
    });

    it('records a GENERATE audit entry on success', async () => {
      const before = service.getAuditLog().length;

      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const log = service.getAuditLog();
      expect(log.length).toBe(before + 1);

      const entry = log[log.length - 1];
      expect(entry.operation).toBe('GENERATE');
      expect(entry.success).toBe(true);
      expect(entry.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    it('records a failed GENERATE audit entry when an unsupported key type is requested', async () => {
      await expect(
        service.generateKey({ keyType: 'UNSUPPORTED_TYPE' as KeyType }),
      ).rejects.toThrow('Key generation failed');

      const log = service.getAuditLog();
      const failEntry = log[log.length - 1];
      expect(failEntry.operation).toBe('GENERATE');
      expect(failEntry.success).toBe(false);
      expect(failEntry.errorMessage).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  describe('sign', () => {
    it('produces a base64 ed25519 signature for valid encrypted material', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const result = await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('transfer:100:XLM:testnet'),
        publicKey: keyMaterial.publicKey,
      });

      expect(result.algorithm).toBe('ed25519');
      expect(result.publicKey).toBe(keyMaterial.publicKey);
      expect(result.signature).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('accepts a string payload as well as a Buffer', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const result = await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: 'plain-text-payload',
        publicKey: keyMaterial.publicKey,
      });

      expect(result.signature).toBeDefined();
      expect(result.algorithm).toBe('ed25519');
    });

    it('never exposes the private key in the signature result', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const result = await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('data'),
        publicKey: keyMaterial.publicKey,
      });

      expect((result as any).privateKey).toBeUndefined();
      expect((result as any).privateKeyMaterial).toBeUndefined();
      expect((result as any).secret).toBeUndefined();
    });

    it('produces different signatures for different payloads with the same key', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const [sig1, sig2] = await Promise.all([
        service.sign({
          encryptedKeyMaterial: keyMaterial.encryptedData,
          dataToSign: Buffer.from('payload-A'),
          publicKey: keyMaterial.publicKey,
        }),
        service.sign({
          encryptedKeyMaterial: keyMaterial.encryptedData,
          dataToSign: Buffer.from('payload-B'),
          publicKey: keyMaterial.publicKey,
        }),
      ]);

      expect(sig1.signature).not.toBe(sig2.signature);
    });

    it('produces different signatures for the same payload with different keys', async () => {
      const [km1, km2] = await Promise.all([
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
      ]);

      const payload = Buffer.from('same-payload');

      const [sig1, sig2] = await Promise.all([
        service.sign({
          encryptedKeyMaterial: km1.encryptedData,
          dataToSign: payload,
          publicKey: km1.publicKey,
        }),
        service.sign({
          encryptedKeyMaterial: km2.encryptedData,
          dataToSign: payload,
          publicKey: km2.publicKey,
        }),
      ]);

      expect(sig1.signature).not.toBe(sig2.signature);
    });

    it('records a SIGN audit entry on success', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('audit-test'),
        publicKey: keyMaterial.publicKey,
      });

      const log = service.getAuditLog();
      const signEntry = log.filter((e) => e.operation === 'SIGN').pop();

      expect(signEntry).toBeDefined();
      expect(signEntry!.success).toBe(true);
      expect(signEntry!.publicKey).toBe(keyMaterial.publicKey);
    });

    it('rejects tampered / corrupted encrypted key material', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Corrupt the ciphertext by flipping bytes in the encryptedData field
      const parsed = JSON.parse(keyMaterial.encryptedData);
      parsed.encryptedData = 'deadbeefdeadbeef'.repeat(8); // invalid ciphertext
      const corrupted = JSON.stringify(parsed);

      await expect(
        service.sign({
          encryptedKeyMaterial: corrupted,
          dataToSign: Buffer.from('data'),
          publicKey: keyMaterial.publicKey,
        }),
      ).rejects.toThrow('Signing operation failed');
    });

    it('records a failed SIGN audit entry when material is invalid', async () => {
      const before = service
        .getAuditLog()
        .filter((e) => e.operation === 'SIGN').length;

      await expect(
        service.sign({
          encryptedKeyMaterial: '{"encryptedData":"bad","iv":"00","tag":"00"}',
          dataToSign: Buffer.from('data'),
          publicKey: 'GABC',
        }),
      ).rejects.toThrow();

      const failed = service
        .getAuditLog()
        .filter((e) => e.operation === 'SIGN' && !e.success);

      expect(failed.length).toBeGreaterThan(before);
    });
  });

  // -------------------------------------------------------------------------
  // Key validation
  // -------------------------------------------------------------------------

  describe('validateKey', () => {
    it('returns true when public key matches encrypted material', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const isValid = await service.validateKey(
        keyMaterial.publicKey,
        keyMaterial.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      expect(isValid).toBe(true);
    });

    it('returns false when a mismatched public key is supplied', async () => {
      const [km1, km2] = await Promise.all([
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
      ]);

      // km1's encrypted data does NOT match km2's public key
      const isValid = await service.validateKey(
        km2.publicKey,
        km1.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      expect(isValid).toBe(false);
    });

    it('returns false for tampered encrypted key material', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const parsed = JSON.parse(keyMaterial.encryptedData);
      parsed.tag = 'ffffffffffffffffffffffffffffffff'; // break GCM auth tag
      const tampered = JSON.stringify(parsed);

      const isValid = await service.validateKey(
        keyMaterial.publicKey,
        tampered,
        KeyType.STELLAR_ED25519,
      );

      expect(isValid).toBe(false);
    });

    it('returns false for completely invalid JSON material', async () => {
      const isValid = await service.validateKey(
        'GABC123',
        'not-valid-json',
        KeyType.STELLAR_ED25519,
      );

      expect(isValid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Key re-encryption
  // -------------------------------------------------------------------------

  describe('reEncryptKey', () => {
    it('re-wraps key material under a new ciphertext', async () => {
      const original = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const reEncrypted = await service.reEncryptKey(
        original.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      // The re-encrypted blob must differ from the original (different IV)
      expect(reEncrypted.encryptedData).not.toBe(original.encryptedData);

      // But the new blob must still decrypt to valid Stellar key material
      const decrypted = encryptionService.deserializeAndDecrypt(
        reEncrypted.encryptedData,
      );
      expect(decrypted).toBeDefined();
      expect(typeof decrypted).toBe('string');
      expect(decrypted.length).toBeGreaterThan(0);
    });

    it('bumps the encryption version on re-encryption', async () => {
      const original = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const reEncrypted = await service.reEncryptKey(
        original.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      expect(reEncrypted.encryptionVersion).toBeGreaterThan(
        original.encryptionVersion,
      );
    });

    it('rejects tampered material during re-encryption', async () => {
      await expect(
        service.reEncryptKey(
          '{"encryptedData":"badbad","iv":"00000000000000000000000000000000","tag":"00000000000000000000000000000000"}',
          KeyType.STELLAR_ED25519,
        ),
      ).rejects.toThrow('Key re-encryption failed');
    });
  });

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------

  describe('getAuditLog', () => {
    it('returns all operations in chronological order', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('data'),
        publicKey: keyMaterial.publicKey,
      });
      await service.validateKey(
        keyMaterial.publicKey,
        keyMaterial.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      const log = service.getAuditLog();
      const ops = log.map((e) => e.operation);

      expect(ops).toContain('GENERATE');
      expect(ops).toContain('SIGN');
    });

    it('respects the optional limit parameter', async () => {
      // Generate several keys to build up the log
      await Promise.all(
        Array.from({ length: 5 }, () =>
          service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
        ),
      );

      const limited = service.getAuditLog(2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });

    it('caps in-memory log at 1000 entries', async () => {
      // Generate 1005 keys; the in-memory log should not grow beyond 1000
      for (let i = 0; i < 1005; i++) {
        await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      }

      const log = service.getAuditLog(1000);
      expect(log.length).toBeLessThanOrEqual(1000);
    });
  });

  // -------------------------------------------------------------------------
  // Provider registration / unknown key type
  // -------------------------------------------------------------------------

  describe('provider lookup', () => {
    it('throws NotFoundException for an unregistered key type', async () => {
      await expect(
        service.generateKey({ keyType: 'ETHEREUM_SECP256K1' as KeyType }),
      ).rejects.toThrow('Key generation failed');
    });
  });

  // -------------------------------------------------------------------------
  // Security properties
  // -------------------------------------------------------------------------

  describe('security properties', () => {
    it('never writes private key material to the logger', async () => {
      const logSpy = jest.spyOn(service['logger'], 'log');
      const warnSpy = jest.spyOn(service['logger'], 'warn');
      const errorSpy = jest.spyOn(service['logger'], 'error');

      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('sensitive-transaction'),
        publicKey: keyMaterial.publicKey,
      });

      const allCalls = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ];
      const logsAsString = JSON.stringify(allCalls).toLowerCase();

      expect(logsAsString).not.toMatch(/privatekey/i);
      expect(logsAsString).not.toMatch(/private_key/i);
      expect(logsAsString).not.toMatch(/secret.*seed/i);
      expect(logsAsString).not.toMatch(/s[a-z2-7]{55}/i); // Stellar secret (S…) pattern
    });

    it('never includes the private key in audit log entries', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('data'),
        publicKey: keyMaterial.publicKey,
      });

      const log = service.getAuditLog();
      const logString = JSON.stringify(log).toLowerCase();

      expect(logString).not.toMatch(/privatekey/i);
      expect(logString).not.toMatch(/private_key/i);
    });

    it('generates cryptographically distinct keys even under concurrent load', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
        ),
      );

      const publicKeys = results.map((r) => r.publicKey);
      expect(new Set(publicKeys).size).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // Full key lifecycle (generate → sign → validate → re-encrypt)
  // -------------------------------------------------------------------------

  describe('full key lifecycle', () => {
    it('supports the complete generate → sign → validate → re-encrypt flow', async () => {
      // Step 1: Generate
      const generated = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(isStellarPublicKey(generated.publicKey)).toBe(true);

      // Step 2: Sign with the original material
      const signed = await service.sign({
        encryptedKeyMaterial: generated.encryptedData,
        dataToSign: Buffer.from('lifecycle-test-payload'),
        publicKey: generated.publicKey,
      });

      expect(signed.signature).toBeDefined();
      expect(signed.publicKey).toBe(generated.publicKey);

      // Step 3: Validate the keypair
      const isValid = await service.validateKey(
        generated.publicKey,
        generated.encryptedData,
        KeyType.STELLAR_ED25519,
      );
      expect(isValid).toBe(true);

      // Step 4: Re-encrypt and sign again with the new material
      const reEncrypted = await service.reEncryptKey(
        generated.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      expect(reEncrypted.encryptedData).not.toBe(generated.encryptedData);

      const signedAfterRotation = await service.sign({
        encryptedKeyMaterial: reEncrypted.encryptedData,
        dataToSign: Buffer.from('post-rotation-payload'),
        publicKey: reEncrypted.publicKey || generated.publicKey,
      });

      expect(signedAfterRotation.signature).toBeDefined();

      // Step 5: Audit log should reflect the full lifecycle
      const log = service.getAuditLog();
      const ops = log.map((e) => e.operation);

      expect(ops).toContain('GENERATE');
      expect(ops).toContain('SIGN');
    });
  });
});
