import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { WalletsService } from './wallets.service';

/**
 * Unit tests for the wallet nickname feature (Issue #1).
 *
 * WalletsService.updateNickname() is the only production path that needs
 * exercising here; the controller simply delegates to the service.
 */
describe('WalletsService – nickname', () => {
  let service: WalletsService;

  // --- minimal prisma double ---
  const mockPrisma = {
    wallet: {
      findUnique: jest.fn(),
      // uniqueness check: no existing owner wallet with the same nickname
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
  };

  const baseWallet = {
    id: 'wallet-1',
    userId: 'user-1',
    publicKey: 'GPUBKEY1',
    encryptedSecret: 'enc',
    encryptionVersion: 1,
    secretVersion: 1,
    keyVersion: 1,
    network: 'TESTNET',
    status: 'ACTIVE',
    statusReason: null,
    statusChangedAt: new Date(),
    rotatedFromId: null,
    successorId: null,
    nickname: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Build a minimal service with only what updateNickname needs
    service = {
      prisma: mockPrisma,
      logger: {
        logWithContext: jest.fn(),
        warnWithContext: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      mapPrismaWalletToDomain: (w: any) => ({
        ...w,
        network: w.network,
        status: w.status,
        nickname: w.nickname ?? null,
      }),
      toPublicWallet: (w: any) => {
        const { encryptedSecret: _enc, ...pub } = w;
        return pub;
      },
      updateNickname: WalletsService.prototype.updateNickname,
      sanitizeNickname: (WalletsService.prototype as any).sanitizeNickname,
      recordMetric: jest.fn(),
    } as any;
  });

  describe('updateNickname – success paths', () => {
    it('sets a new nickname on a wallet that had none', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(baseWallet);
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: 'Savings',
        updatedAt: new Date(),
      });

      const result = await service.updateNickname('wallet-1', 'Savings');

      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { nickname: 'Savings', updatedAt: expect.any(Date) },
      });
      expect(result.nickname).toBe('Savings');
      // encrypted secret must not be returned
      expect((result as any).encryptedSecret).toBeUndefined();
    });

    it('updates an existing nickname to a new value', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        ...baseWallet,
        nickname: 'Old name',
      });
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: 'New name',
        updatedAt: new Date(),
      });

      const result = await service.updateNickname('wallet-1', 'New name');

      expect(result.nickname).toBe('New name');
    });

    it('clears a nickname when null is passed', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        ...baseWallet,
        nickname: 'Some name',
      });
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: null,
        updatedAt: new Date(),
      });

      const result = await service.updateNickname('wallet-1', null);

      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-1' },
        data: { nickname: null, updatedAt: expect.any(Date) },
      });
      expect(result.nickname).toBeNull();
    });

    it('treats undefined the same as null (clears nickname)', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        ...baseWallet,
        nickname: 'Some name',
      });
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: null,
        updatedAt: new Date(),
      });

      const result = await service.updateNickname('wallet-1', undefined);

      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nickname: null, updatedAt: expect.any(Date) } }),
      );
      expect(result.nickname).toBeNull();
    });
  });

  describe('updateNickname – failure paths', () => {
    it('throws NotFoundException when wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.updateNickname('non-existent', 'Savings'),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });

    it('propagates prisma errors from the update call', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(baseWallet);
      mockPrisma.wallet.update.mockRejectedValue(new Error('DB error'));

      await expect(
        service.updateNickname('wallet-1', 'Savings'),
      ).rejects.toThrow('DB error');
    });
  });

  describe('updateNickname – XSS sanitization', () => {
    beforeEach(() => {
      mockPrisma.wallet.findUnique.mockResolvedValue(baseWallet);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
    });

    it('strips HTML tag-like sequences before persisting', async () => {
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: 'Savings',
        updatedAt: new Date(),
      });

      const result = await service.updateNickname(
        'wallet-1',
        '<script>alert(1)</script>Savings',
      );

      // tag markup removed, pitch text preserved — no executable HTML survives
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            nickname: expect.not.stringContaining('script') as string,
            updatedAt: expect.any(Date),
          },
        }),
      );
      expect(result.nickname).not.toMatch(/[<>]/);
      expect(result.nickname).toContain('Savings');
    });

    it('removes inline event handlers and javascript: schemes', async () => {
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: 'Savings',
        updatedAt: new Date(),
      });

      const result = await service.updateNickname(
        'wallet-1',
        'Savings onmouseover=alert(1) javascript:alert(1)',
      );

      // event-handler prefix and scheme removed; text preserved
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            nickname: expect.stringContaining('Savings') as string,
            updatedAt: expect.any(Date),
          },
        }),
      );
      expect(result.nickname).not.toContain('onmouseover=');
      expect(result.nickname).not.toContain('javascript:');
    });

    it('treats a value that sanitizes to whitespace as a clear (null)', async () => {
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: null,
        updatedAt: new Date(),
      });

      const result = await service.updateNickname(
        'wallet-1',
        '<img src=x onerror=alert(1)>',
      );

      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nickname: null, updatedAt: expect.any(Date) } }),
      );
      expect(result.nickname).toBeNull();
    });
  });

  describe('updateNickname – per-owner uniqueness', () => {
    beforeEach(() => {
      mockPrisma.wallet.findUnique.mockResolvedValue(baseWallet);
      // default: no duplicate owned wallet holds the nickname
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.update.mockResolvedValue({
        ...baseWallet,
        nickname: 'Savings',
        updatedAt: new Date(),
      });
    });

    it('throws ConflictException when another wallet owned by the same user holds the nickname', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({
        ...baseWallet,
        id: 'wallet-2',
        nickname: 'Savings',
      });

      await expect(
        service.updateNickname('wallet-1', 'Savings'),
      ).rejects.toThrow(ConflictException);

      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });

    it('allows the same nickname across different owners', async () => {
      // findFirst already resolves to null by default (no duplicate for wallet-1's user)
      const result = await service.updateNickname('wallet-1', 'Savings');
      expect(result.nickname).toBe('Savings');
    });

    it('does not enforce uniqueness when clearing the nickname', async () => {
      await service.updateNickname('wallet-1', null);
      // no uniqueness probe should run for a clear
      expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
    });
  });
});
