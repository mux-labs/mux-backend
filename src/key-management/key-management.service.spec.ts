import { Test, TestingModule } from '@nestjs/testing';
import { KeyManagementService } from './key-management.service';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { KeyOperation, KeyType } from './domain/key-types';

describe('KeyManagementService', () => {
  let service: KeyManagementService;
  let logEntry: jest.Mock;

  beforeEach(async () => {
    logEntry = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyManagementService,
        {
          provide: KeyRotationAuditService,
          useValue: { logEntry },
        },
      ],
    }).compile();

    service = module.get<KeyManagementService>(KeyManagementService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateKey audit entry', () => {
    it('writes a success audit entry for the GENERATE operation', async () => {
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      expect(logEntry).toHaveBeenCalledTimes(1);
      const entry = logEntry.mock.calls[0][0];

      expect(entry.operation).toBe(KeyOperation.GENERATE);
      expect(entry.success).toBe(true);
    });

    it('carries a UUID-shaped requestId that differs between consecutive calls', async () => {
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      expect(logEntry).toHaveBeenCalledTimes(2);
      const firstEntry = logEntry.mock.calls[0][0];
      const secondEntry = logEntry.mock.calls[1][0];

      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      expect(typeof firstEntry.requestId).toBe('string');
      expect(firstEntry.requestId).toMatch(uuidPattern);
      expect(secondEntry.requestId).toMatch(uuidPattern);
      expect(firstEntry.requestId).not.toBe(secondEntry.requestId);
    });

    it('never includes the returned encryptedSecret in the audit entry', async () => {
      const result = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(logEntry).toHaveBeenCalledTimes(1);
      const entry = logEntry.mock.calls[0][0];

      expect(result.encryptedSecret).toBeDefined();
      expect(JSON.stringify(entry)).not.toContain(result.encryptedSecret);
    });
  });

  describe('generateKey regression (#1326)', () => {
    it('generates a new Stellar Ed25519 keypair and returns the public key and encrypted secret', async () => {
      const result = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(result.publicKey).toEqual(expect.any(String));
      expect(result.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
      expect(result.encryptedSecret).toEqual(expect.any(String));
      expect(result.encryptedSecret.length).toBeGreaterThan(0);
      expect(result.keyType).toBe(KeyType.STELLAR_ED25519);
      expect(result.createdAt).toEqual(expect.any(String));
      expect(result.publicKey).not.toBe(result.encryptedSecret);
    });
  });
  describe('sign regression (#1327)', () => {
    it('signs data using the provided encrypted key material without exposing the private key in the response or logs', async () => {
      const generated = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      const dataToSign = 'payment:123:approve';
      const logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation();
      const errorSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation();

      const result = await service.sign({
        encryptedKeyMaterial: generated.encryptedSecret,
        dataToSign,
        publicKey: generated.publicKey,
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(result.signature).toEqual(expect.any(String));
      expect(result.signature.length).toBeGreaterThan(0);
      expect(result.publicKey).toBe(generated.publicKey);
      expect(result.algorithm).toBe('ed25519');
      expect(result.timestamp).toEqual(expect.any(String));

      const serializedResult = JSON.stringify(result);
      expect(serializedResult).not.toContain(generated.encryptedSecret);
      expect(serializedResult).not.toContain('encryptedKeyMaterial');
      expect(serializedResult).not.toContain('privateKey');
      expect(serializedResult).not.toContain('secret');

      const logOutput = JSON.stringify([
        ...logSpy.mock.calls,
        ...errorSpy.mock.calls,
        ...warnSpy.mock.calls,
      ]);
      expect(logOutput).not.toContain(generated.encryptedSecret);

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('fails closed when key material cannot be used for signing and does not leak key material', async () => {
      const generated = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      const badMaterial = 'not-a-valid-secret';
      const errorSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation();

      await expect(
        service.sign({
          encryptedKeyMaterial: badMaterial,
          dataToSign: 'payload',
          publicKey: generated.publicKey,
          keyType: KeyType.STELLAR_ED25519,
        }),
      ).rejects.toBeDefined();

      const logOutput = JSON.stringify(errorSpy.mock.calls);
      expect(logOutput).not.toContain(badMaterial);

      errorSpy.mockRestore();
    });
  });
});
