import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';
import { WalletsService } from '../wallets/wallets.service';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { PaymentStatus } from './entities/payment.entity';

const ACTIVE_WALLET = { id: 'wallet-uuid-sender', status: WalletStatus.ACTIVE };
const RECEIVER_WALLET = { id: 'wallet-uuid-receiver', status: WalletStatus.ACTIVE };

const BASE_DTO = {
  walletId: 'wallet-uuid-sender',
  receiverWalletId: 'wallet-uuid-receiver',
  fromId: 1,
  toId: 2,
  amount: 100,
  currency: 'USD',
  description: 'Test payment',
};

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: any;
  let limitsService: any;
  let walletsService: any;

  beforeEach(async () => {
    prisma = {
      payment: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    limitsService = { checkLimits: jest.fn() };
    walletsService = { findWalletById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LimitsService, useValue: limitsService },
        { provide: WalletsService, useValue: walletsService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create payment when sender wallet is ACTIVE and limits pass', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      limitsService.checkLimits.mockResolvedValue(undefined);
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...BASE_DTO,
        status: PaymentStatus.PENDING,
      });

      const result = await service.create(BASE_DTO);

      expect(walletsService.findWalletById).toHaveBeenCalledWith(BASE_DTO.walletId);
      expect(walletsService.findWalletById).toHaveBeenCalledWith(
        BASE_DTO.receiverWalletId,
      );
      expect(limitsService.checkLimits).toHaveBeenCalledWith(
        BASE_DTO.walletId,
        BASE_DTO.amount,
      );
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          fromId: BASE_DTO.fromId,
          toId: BASE_DTO.toId,
          amount: BASE_DTO.amount,
          currency: BASE_DTO.currency,
          description: BASE_DTO.description,
          userId: BASE_DTO.fromId,
          status: PaymentStatus.PENDING,
        },
      });
      expect(result.status).toBe(PaymentStatus.PENDING);
    });

    it('should throw BadRequestException when sender wallet is not ACTIVE', async () => {
      walletsService.findWalletById.mockResolvedValue({
        ...ACTIVE_WALLET,
        status: WalletStatus.SUSPENDED,
      });

      await expect(service.create(BASE_DTO)).rejects.toThrow(BadRequestException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update payment status', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 1,
        status: PaymentStatus.PENDING,
      });
      prisma.payment.update.mockResolvedValue({
        id: 1,
        status: PaymentStatus.CONFIRMED,
      });

      const result = await service.update('1', {
        status: PaymentStatus.CONFIRMED,
      });

      expect(result.status).toBe(PaymentStatus.CONFIRMED);
    });

    it('should throw NotFoundException when payment does not exist', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      await expect(
        service.update('99', { status: PaymentStatus.CONFIRMED }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
