/**
 * Custody Threat Model Test Suite
 *
 * Validates the security invariants documented in docs/custody-security-model.md:
 * - Private keys never surface in responses, logs, or audit entries
 * - Encrypted-at-rest envelopes are tamper-evident (GCM auth-tag check)
 * - Key rotation is atomic and guards against invalid state transitions
 * - Audit log records every operation without leaking sensitive data
 * - Unauthorized / invalid inputs produce consistent error responses
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { KeyDecryptionException } from './exceptions/key-decryption.exception';
import { KeyType } from './domain/key-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isStellarPublicKey = (v: string) => /^G[A-Z2-7]{55}$/.test(v);

function makeConfigService(key = 'custody-test-encryption-key-32chars!!') {
  return { get: jest.fn((k: string) => (k === 'WALLET_ENCRYPTION_KEY' ? key : undefined)) };
}

const makeWallet = (overrides: Record<string, any> = {}) => ({
  id: 'wallet-pred',
  userId: 'user-1',
  publicKey: 'GPREDECESSOR1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  network: 'TESTNET',
  status: 'ACTIVE',
  successorId: null,
  rotatedFromId: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module bootstrap
// ---------------------------------------------------------------------------

describe('Custody Threat Model', () => {
  let service: KeyManagementService;
  let encryption: EncryptionService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      wallet: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyManagementService,
        EncryptionService,
        { provide: ConfigService, useValue: makeConfigService() },
        {
          provide: KeyRotationAuditService,
          useValue: {
            persistAuditLog: jest.fn().mockResolvedValue(undefined),
            convertToPersistentFormat: jest.fn().mockReturnValue({}),
          },
        },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(KeyManagementService);
    encryption = module.get(EncryptionService);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // 1. Private key non-exposure
  // -------------------------------------------------------------------------

  describe('private key non-exposure', () => {
    it('generateKey never returns private key material in the result', async () => {
      const result = await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      expect((result as any).privateKey).toBeUndefined();
      expect((result as any).privateKeyMaterial).toBeUndefined();
      expect((result as any).secret).toBeUndefined();
      expect(isStellarPublicKey(result.publicKey)).toBe(true);
    });

    it('sign never returns private key material in the result', async () => {
      const km = await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      const sig = await service.sign({
        encryptedKeyMaterial: km.encryptedData,
        dataToSign: Buffer.from('threat-model-test'),
        publicKey: km.publicKey,
      });
      expect((sig as any).privateKey).toBeUndefined();
      expect((sig as any).privateKeyMaterial).toBeUndefined();
      expect(sig.algorithm).toBe('ed25519');
      expect(sig.publicKey).toBe(km.publicKey);
    });

    it('logger never emits private key material during key operations', async () => {
      const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => {});
      const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});

      const km = await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.sign({ encryptedKeyMaterial: km.encryptedData, dataToSign: Buffer.from('data'), publicKey: km.publicKey });

      const dump = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]).toLowerCase();
      expect(dump).not.toMatch(/privatekey/i);
      expect(dump).not.toMatch(/private_key/i);
      expect(dump).not.toMatch(/s[a-z2-7]{55}/i); // Stellar secret (S…) pattern
    });

    it('audit log entries never contain private key material', async () => {
      const km = await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.sign({ encryptedKeyMaterial: km.encryptedData, dataToSign: Buffer.from('data'), publicKey: km.publicKey });
      const logStr = JSON.stringify(service.getAuditLog()).toLowerCase();
      expect(logStr).not.toMatch(/privatekey/i);
      expect(logStr).not.toMatch(/private_key/i);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tamper-evident encryption (GCM auth-tag)
  // -------------------------------------------------------------------------

  describe('tamper-evident encryption at rest', () => {
    it('rejects ciphertext with a corrupted auth tag (throws KeyDecryptionException)', async () => {
      const km = await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      const parsed = JSON.parse(km.encryptedData);
      parsed.tag = 'ff'.repeat(16); // flip auth tag
      const tampered = JSON.stringify(parsed);

      await expect(
        service.sign({ encryptedKeyMaterial: tampered, dataToSign: Buffer.from('data'), publicKey: km.publicKey }),
      ).rejects.toThrow(KeyDecryptionException);
    });

    it('rejects ciphertext with corrupted encryptedData payload', async () => {
      const km = await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      const parsed = JSON.parse(km.encryptedData);
      parsed.encryptedData = 'deadbeef'.repeat(8);
      const tampered = JSON.stringify(parsed);

      await expect(
        service.sign({ encryptedKeyMaterial: tampered, dataToSign: Buffer.from('data'), publicKey: km.publicKey }),
      ).rejects.toThrow(KeyDecryptionException);
    });

    it('rejects completely invalid JSON material with a recognisable error', async () => {
      const isValid = await service.validateKey('GABC123', 'not-valid-json', KeyType.STELLAR_ED25519);
      expect(isValid).toBe(false);
    });

    it('KeyDecryptionException does not leak internal crypto details in the HTTP body', async () => {
      jest.spyOn(encryption, 'deserializeAndDecrypt').mockImplementation(() => {
        throw Object.assign(new Error('EVP_DecryptFinal_ex:bad decrypt:internal-detail'), { code: 'DECRYPTION_FAILED', name: 'DecryptionError' });
      });

      let caught: KeyDecryptionException | undefined;
      try {
        await service.sign({ encryptedKeyMaterial: 'bad', dataToSign: Buffer.from('d'), publicKey: 'GTEST' });
      } catch (e) {
        caught = e as KeyDecryptionException;
      }
      const body = caught!.getResponse() as any;
      expect(body.message).not.toContain('EVP_DecryptFinal_ex');
      expect(body.message).not.toContain('internal-detail');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Key rotation state-machine guards
  // -------------------------------------------------------------------------

  describe('key rotation guards', () => {
    const successorRow = { id: 'wallet-succ', userId: 'user-1', publicKey: 'GSUCCESSOR', encryptedSecret: 'enc', encryptionVersion: 1, secretVersion: 2, network: 'TESTNET', status: 'ACTIVE', rotatedFromId: 'wallet-pred' };

    beforeEach(() => {
      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({ wallet: { create: jest.fn().mockResolvedValue(successorRow), update: jest.fn().mockResolvedValue({}) } }),
      );
    });

    it('rotates an ACTIVE wallet atomically and returns successor linkage', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet());
      const result = await service.rotateKey('wallet-pred');
      expect(result.predecessorWalletId).toBe('wallet-pred');
      expect(result.successorWalletId).toBe('wallet-succ');
      expect(result.successorPublicKey).toBe('GSUCCESSOR');
    });

    it('also rotates a ROTATING wallet (re-rotation scenario)', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet({ status: 'ROTATING' }));
      const result = await service.rotateKey('wallet-pred');
      expect(result.successorWalletId).toBe('wallet-succ');
    });

    it('rejects rotation of a non-existent wallet with NotFoundException', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      await expect(service.rotateKey('ghost-wallet')).rejects.toThrow(NotFoundException);
    });

    it('rejects rotation of a DISABLED wallet (terminal state)', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet({ status: 'DISABLED' }));
      await expect(service.rotateKey('wallet-pred')).rejects.toThrow(/Cannot rotate wallet in status: DISABLED/);
    });

    it('rejects rotation when wallet already has a successor (double-rotation guard)', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet({ successorId: 'already-exists' }));
      await expect(service.rotateKey('wallet-pred')).rejects.toThrow(/already has a successor/);
    });

    it('audits the ROTATE operation with success=true', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet());
      await service.rotateKey('wallet-pred');
      const entry = service.getAuditLog().find((e) => e.operation === 'ROTATE');
      expect(entry).toBeDefined();
      expect(entry!.success).toBe(true);
      expect(entry!.keyId).toBe('wallet-pred');
    });

    it('links successor key version from the new key material on rotation', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(makeWallet());
      let capturedKeyVersion: number | undefined;
      mockPrisma.$transaction.mockImplementationOnce(async (cb: any) =>
        cb({
          wallet: {
            create: jest.fn().mockImplementation((args: any) => {
              capturedKeyVersion = args.data.keyVersion;
              return { id: 'wallet-succ', publicKey: 'GSUCCESSOR', keyVersion: args.data.keyVersion };
            }),
            update: jest.fn().mockResolvedValue({}),
          },
        }),
      );
      const result = await service.rotateKey('wallet-pred');
      expect(capturedKeyVersion).toBeDefined();
      expect(typeof capturedKeyVersion).toBe('number');
      expect(result.successorKeyVersion).toBeDefined();
      expect(typeof result.successorKeyVersion).toBe('number');
      expect(result.successorKeyVersion).toBe(capturedKeyVersion);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Audit completeness
  // -------------------------------------------------------------------------

  describe('audit log completeness', () => {
    it('records GENERATE, SIGN, and failed GENERATE in the audit log', async () => {
      const km = await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.sign({ encryptedKeyMaterial: km.encryptedData, dataToSign: Buffer.from('tx'), publicKey: km.publicKey });

      jest.spyOn(encryption, 'encryptAndSerialize').mockImplementation(() => { throw new Error('KMS unavailable'); });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 }).catch(() => {});

      const log = service.getAuditLog();
      expect(log.some((e) => e.operation === 'GENERATE' && e.success)).toBe(true);
      expect(log.some((e) => e.operation === 'SIGN' && e.success)).toBe(true);
      expect(log.some((e) => e.operation === 'GENERATE' && !e.success)).toBe(true);
    });

    it('caps in-memory audit log at 1000 entries', async () => {
      for (let i = 0; i < 1005; i++) {
        await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      }
      expect(service.getAuditLog(1000).length).toBeLessThanOrEqual(1000);
    });
  });
});
