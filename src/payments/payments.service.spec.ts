import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { LimitsService } from '../limits/limits.service';
import { WalletStatus } from '@prisma/client';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: {
    payment: {
      create: jest.Mock;
    };
  };
  let walletsService: {
    findWalletById: jest.Mock;
  };
  let limitsService: {
    checkLimits: jest.Mock;
  };

  const walletId = '11111111-1111-1111-1111-111111111111';
  const fromId = 42;

  beforeEach(async () => {
    prisma = {
      payment: {
        create: jest.fn(),
      },
    };

    walletsService = {
      findWalletById: jest.fn().mockResolvedValue({
        id: walletId,
        status: WalletStatus.ACTIVE,
        developerId: 'dev-1',
      }),
    };

    limitsService = {
      checkLimits: jest.fn().mockResolvedValue({ allowed: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletsService, useValue: walletsService },
        { provide: LimitsService, useValue: limitsService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  it('checks limits against the sender wallet UUID, not the legacy fromId', async () => {
    prisma.payment.create.mockResolvedValue({ id: 'payment-1' });

    await service.create({
      walletId,
      fromId,
      amount: 100,
      developerId: 'dev-1',
    } as any);

    expect(limitsService.checkLimits).toHaveBeenCalledWith(walletId, 100);
    expect(limitsService.checkLimits).not.toHaveBeenCalledWith(fromId, 100);
  });

  it('propagates ForbiddenException from checkLimits and does not create a payment row', async () => {
    limitsService.checkLimits.mockRejectedValue(
      new ForbiddenException('Daily limit exceeded'),
    );

    await expect(
      service.create({
        walletId,
        fromId,
        amount: 100,
        developerId: 'dev-1',
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

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
});
