import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { LimitsService } from '../limits/limits.service';
import { WalletStatus } from '@prisma/client';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: {
    payment: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    senderWallet: {
      findUnique: jest.Mock;
    };
  };
  let walletsService: {
    findWalletById: jest.Mock;
    getWallet: jest.Mock;
  };
  let limitsService: {
    checkLimits: jest.Mock;
    checkAndConsume: jest.Mock;
  };

  const walletId = '11111111-1111-1111-1111-111111111111';
  const receiverWalletId = '22222222-2222-2222-2222-222222222222';
  const fromId = 42;

  const developerOwnerId = 'dev-owner-1';
  const otherDeveloperOwnerId = 'dev-owner-2';

  const buildPayment = (overrides: Record<string, unknown> = {}) => ({
    id: 'payment-1',
    idempotencyKey: 'key-1',
    developerOwnerId,
    senderWalletId: 'wallet-1',
    amount: 100,
    currency: 'USD',
    status: 'PENDING',
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      payment: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      senderWallet: {
        findUnique: jest.fn(),
      },
    };
    limits = { checkAndConsume: jest.fn().mockResolvedValue(undefined) };
    wallets = { getWallet: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LimitsService, useValue: limits },
        { provide: WalletsService, useValue: wallets },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
  });

  it('replays the cached payment for the same developer without creating a new one', async () => {
    const existing = buildPayment();
    prisma.payment.findUnique.mockResolvedValue(existing);

    const result = await service.create(developerOwnerId, {
      idempotencyKey: 'key-1',
      senderWalletId: 'wallet-1',
      amount: 100,
      currency: 'USD',
    } as never);

    expect(result).toBe(existing);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the idempotency key belongs to another developer', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({ developerOwnerId: otherDeveloperOwnerId }),
    );

    await expect(
      service.create(developerOwnerId, {
        idempotencyKey: 'key-1',
        senderWalletId: 'wallet-1',
        amount: 100,
        currency: 'USD',
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('creates the payment row when checkLimits allows the payment', async () => {
    prisma.payment.create.mockResolvedValue({ id: 'payment-1' });

    await service.create({
      walletId,
      fromId,
      amount: 100,
      developerId: 'dev-1',
    } as any);

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-ACTIVE receiver wallet and does not create a payment row', async () => {
    walletsService.findWalletById.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        status:
          id === receiverWalletId
            ? WalletStatus.DISABLED
            : WalletStatus.ACTIVE,
        developerId: 'dev-1',
      }),
    );

    await expect(
      service.create({
        walletId,
        receiverWalletId,
        fromId,
        amount: 100,
        developerId: 'dev-1',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('rejects a receiver wallet owned by a different developer and does not create a payment row', async () => {
    walletsService.findWalletById.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        status: WalletStatus.ACTIVE,
        developerId: id === receiverWalletId ? 'dev-2' : 'dev-1',
      }),
    );

    await expect(
      service.create({
        walletId,
        receiverWalletId,
        fromId,
        amount: 100,
        developerId: 'dev-1',
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('does not reveal ownership details in the NotFoundException message', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      buildPayment({ developerOwnerId: otherDeveloperOwnerId }),
    );

    await expect(
      service.create(developerOwnerId, {
        idempotencyKey: 'key-1',
        senderWalletId: 'wallet-1',
        amount: 100,
        currency: 'USD',
      } as never),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(otherDeveloperOwnerId),
      }),
    );
  });

  it('creates a new payment when no idempotency key is supplied', async () => {
    const created = buildPayment({ id: 'payment-2', idempotencyKey: null });
    prisma.senderWallet.findUnique.mockResolvedValue({
      id: 'wallet-1',
      userId: developerOwnerId,
    });
    prisma.payment.create.mockResolvedValue(created);

    const result = await service.create(developerOwnerId, {
      senderWalletId: 'wallet-1',
      amount: 100,
      currency: 'USD',
    } as never);

    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(result).toBe(created);
  });
});
  });
});
