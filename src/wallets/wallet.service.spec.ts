import { Test } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WalletService.setSuccessor', () => {
  let service: WalletService;
  let prisma: {
    wallet: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  const ownerId = 'owner-1';
  const walletId = 'wallet-1';
  const successorId = 'wallet-2';

  const wallet = (overrides: Record<string, unknown> = {}) => ({
    id: walletId,
    ownerId,
    successorId: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      wallet: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(WalletService);
  });

  it('sets the successor when the caller is the owner', async () => {
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(wallet({ id: successorId }));
    prisma.wallet.update.mockResolvedValue(
      wallet({ successorId }),
    );

    await service.setSuccessor(walletId, successorId, ownerId);

    expect(prisma.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: walletId },
        data: { successorId },
      }),
    );
  });

  it('clears the successor when successorId is null', async () => {
    prisma.wallet.findUnique.mockResolvedValueOnce(
      wallet({ successorId }),
    );
    prisma.wallet.update.mockResolvedValue(wallet());

    await service.setSuccessor(walletId, null, ownerId);

    expect(prisma.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: walletId },
        data: { successorId: null },
      }),
    );
  });

  it('rejects a caller who is not the owner', async () => {
    prisma.wallet.findUnique.mockResolvedValueOnce(wallet());

    await expect(
      service.setSuccessor(walletId, successorId, 'intruder'),
    ).rejects.toThrow();

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  it('rejects a successor owned by a different owner (no cross-tenant)', async () => {
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(wallet({ id: successorId, ownerId: 'other' }));

    await expect(
      service.setSuccessor(walletId, successorId, ownerId),
    ).rejects.toThrow();

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  it('rejects a missing successor', async () => {
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(null);

    await expect(
      service.setSuccessor(walletId, successorId, ownerId),
    ).rejects.toThrow();

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  it('rejects a self-reference', async () => {
    prisma.wallet.findUnique.mockResolvedValueOnce(wallet());

    await expect(
      service.setSuccessor(walletId, walletId, ownerId),
    ).rejects.toThrow();

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  it('rejects a successor chain that would create a cycle', async () => {
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(wallet({ id: successorId, successorId: walletId }));

    await expect(
      service.setSuccessor(walletId, successorId, ownerId),
    ).rejects.toThrow();

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  it('is idempotent when the same successor is set again', async () => {
    prisma.wallet.findUnique.mockResolvedValueOnce(
      wallet({ successorId }),
    );

    await service.setSuccessor(walletId, successorId, ownerId);

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  it('fails closed when the dependency is unavailable on write', async () => {
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(wallet({ id: successorId }));
    prisma.wallet.update.mockRejectedValue(new Error('db down'));

    await expect(
      service.setSuccessor(walletId, successorId, ownerId),
    ).rejects.toThrow();
  });
});
