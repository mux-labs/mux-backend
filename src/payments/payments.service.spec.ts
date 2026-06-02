import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';
import { PaymentStatus } from './entities/payment.entity';

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
      const paymentDate = new Date();
      prisma.payment.create.mockResolvedValue({
        id: 1,
        ...BASE_DTO,
        status: 'PENDING',
        userId: 1,
        createdAt: paymentDate,
        updatedAt: paymentDate,
      });

      const result = await service.create(BASE_DTO as any);

      expect(walletsService.findWalletById).toHaveBeenCalledWith('wallet-uuid-1');
      expect(walletsService.findWalletById).toHaveBeenCalledWith('wallet-uuid-2');
      expect(limitsService.checkLimits).toHaveBeenCalledWith(1, 100);
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          fromId: 1,
          toId: 2,
          amount: 100,
          currency: 'USD',
          description: 'Test payment',
          userId: 1,
          status: 'PENDING',
        },
      });
      expect(result.status).toBe('PENDING');
    });

    it('should throw BadRequestException when sender wallet is SUSPENDED', async () => {
      walletsService.findWalletById.mockResolvedValue({
        ...ACTIVE_WALLET,
        status: WalletStatus.SUSPENDED,
      });

      await expect(service.create(BASE_DTO as any)).rejects.toThrow(BadRequestException);
      await expect(service.create(BASE_DTO as any)).rejects.toThrow(
        'Sender wallet is not active',
      );
      expect(limitsService.checkLimits).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when sender wallet is DISABLED', async () => {
      walletsService.findWalletById.mockResolvedValueOnce({
        ...ACTIVE_WALLET,
        status: WalletStatus.DISABLED,
      });

      await expect(service.create(BASE_DTO as any)).rejects.toThrow(BadRequestException);
    });

    it('should propagate NotFoundException when sender wallet does not exist', async () => {
      walletsService.findWalletById.mockRejectedValueOnce(
        new NotFoundException('Wallet with ID wallet-uuid-1 not found'),
      );

      await expect(service.create(BASE_DTO as any)).rejects.toThrow(NotFoundException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('should propagate NotFoundException when receiver wallet does not exist', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockRejectedValueOnce(new NotFoundException('Wallet with ID wallet-uuid-2 not found'));

      await expect(service.create(BASE_DTO as any)).rejects.toThrow(NotFoundException);
      expect(limitsService.checkLimits).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('should throw if limits check fails', async () => {
      walletsService.findWalletById
        .mockResolvedValueOnce(ACTIVE_WALLET)
        .mockResolvedValueOnce(RECEIVER_WALLET);
      limitsService.checkLimits.mockRejectedValue(new Error('Transaction limit exceeded'));

      await expect(service.create(BASE_DTO as any)).rejects.toThrow('Transaction limit exceeded');
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('should include wallet status in error message for inactive wallet', async () => {
      walletsService.findWalletById.mockResolvedValueOnce({
        ...ACTIVE_WALLET,
        status: WalletStatus.COMPROMISED,
      });

      await expect(service.create(BASE_DTO as any)).rejects.toThrow(
        `Sender wallet is not active (status: ${WalletStatus.COMPROMISED})`,
      );
    });
  });

  describe('update', () => {
    const pendingPayment = {
      id: 1,
      status: PaymentStatus.PENDING,
      amount: 100,
      currency: 'USD',
    };

    it('should update status from PENDING to CONFIRMED', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment);
      const updated = { ...pendingPayment, status: PaymentStatus.CONFIRMED };
      prisma.payment.update.mockResolvedValue(updated);

      const result = await service.update(1, { status: PaymentStatus.CONFIRMED });

      expect(prisma.payment.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { status: PaymentStatus.CONFIRMED },
      });
      expect(result.status).toBe(PaymentStatus.CONFIRMED);
    });

    it('should update status from PENDING to FAILED', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment);
      const updated = { ...pendingPayment, status: PaymentStatus.FAILED };
      prisma.payment.update.mockResolvedValue(updated);

      const result = await service.update(1, { status: PaymentStatus.FAILED });

      expect(result.status).toBe(PaymentStatus.FAILED);
    });

    it('should update description without status change', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment);
      const updated = { ...pendingPayment, description: 'new desc' };
      prisma.payment.update.mockResolvedValue(updated);

      const result = await service.update(1, { description: 'new desc' });

      expect(prisma.payment.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { description: 'new desc' },
      });
      expect(result.description).toBe('new desc');
    });

    it('should throw NotFoundException when payment does not exist', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      await expect(
        service.update(99, { status: PaymentStatus.CONFIRMED }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when transitioning from CONFIRMED', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        ...pendingPayment,
        status: PaymentStatus.CONFIRMED,
      });

      await expect(
        service.update(1, { status: PaymentStatus.FAILED }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when transitioning from FAILED', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        ...pendingPayment,
        status: PaymentStatus.FAILED,
      });

      await expect(
        service.update(1, { status: PaymentStatus.CONFIRMED }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when transitioning PENDING to PENDING', async () => {
      prisma.payment.findUnique.mockResolvedValue(pendingPayment);

      await expect(
        service.update(1, { status: PaymentStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });
  });
});
