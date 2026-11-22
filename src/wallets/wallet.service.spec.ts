import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';

describe('WalletService.caller', () => {
  let service: WalletService;
  let prisma: {
    wallet: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  const ownerId = 'owner-1';
  const delegateId = 'delegate-1';
  const strangerId = 'stranger-1';
  const walletId = 'wallet-1';

  beforeEach(async () => {
    prisma = {
      wallet: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  it('allows the wallet owner to mutate successor_id', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: walletId,
      owner_id: ownerId,
      delegates: [],
      guardians: [],
    });
    prisma.wallet.update.mockResolvedValue({
      id: walletId,
      successor_id: 'successor-1',
    });

    const result = await service.caller(
      { id: ownerId } as any,
      walletId,
      { successor_id: 'successor-1' } as any,
    );

    expect(prisma.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: walletId },
        data: expect.objectContaining({ successor_id: 'successor-1' }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ successor_id: 'successor-1' }),
    );
  });

  it('allows an explicitly authorized delegate to mutate successor_id', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: walletId,
      owner_id: ownerId,
      delegates: [{ actor_id: delegateId }],
      guardians: [],
    });
    prisma.wallet.update.mockResolvedValue({
      id: walletId,
      successor_id: 'successor-2',
    });

    await expect(
      service.caller(
        { id: delegateId } as any,
        walletId,
        { successor_id: 'successor-2' } as any,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ successor_id: 'successor-2' }),
    );
  });

  it('denies an unauthorized actor by default (failure path)', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: walletId,
      owner_id: ownerId,
      delegates: [],
      guardians: [],
    });

    await expect(
      service.caller(
        { id: strangerId } as any,
        walletId,
        { successor_id: 'successor-3' } as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });
});
