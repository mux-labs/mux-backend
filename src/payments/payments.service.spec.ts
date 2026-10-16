import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';
import { WalletsService } from '../wallets/wallets.service';

describe('PaymentsService.create idempotency', () => {
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
  let limits: { checkAndConsume: jest.Mock };
  let wallets: { getWallet: jest.Mock };

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
