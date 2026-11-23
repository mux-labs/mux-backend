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
});
