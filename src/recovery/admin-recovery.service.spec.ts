import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AdminRecoveryService } from './admin-recovery.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecoveryStatus } from './domain/recovery.model';
import { WalletsService } from '../wallets/wallets.service';

describe('AdminRecoveryService', () => {
  let service: AdminRecoveryService;
  let prismaMock: any;
  let walletsMock: any;

  beforeEach(async () => {
    prismaMock = {
      recoveryRequest: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
    };
    walletsMock = { rotateWalletKey: jest.fn().mockResolvedValue({
      wallet: { publicKey: 'GROTATED', secretVersion: 2 },
    }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminRecoveryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: WalletsService, useValue: walletsMock },
      ],
    }).compile();

    service = module.get<AdminRecoveryService>(AdminRecoveryService);
  });

  describe('approveRecovery', () => {
    it('should approve recovery when in IN_REVIEW status', async () => {
      const recoveryId = 'recovery-1';
      const adminId = 'admin-1';

      prismaMock.recoveryRequest.findUnique.mockResolvedValue({
        id: recoveryId,
        walletId: 'wallet-1',
        status: RecoveryStatus.IN_REVIEW,
        requester: 'user-1',
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      prismaMock.recoveryRequest.update.mockResolvedValue({
        id: recoveryId,
        walletId: 'wallet-1',
        status: RecoveryStatus.APPROVED,
        requester: 'user-1',
        metadata: { approvedBy: adminId },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.approveRecovery({
        recoveryId,
        adminId,
        approvalNotes: 'Looks good',
      });

      expect(result.status).toBe(RecoveryStatus.COMPLETED);
      expect(result.approvedBy).toBe(adminId);
      expect(walletsMock.rotateWalletKey).toHaveBeenCalledWith('wallet-1');
      expect(prismaMock.recoveryRequest.update).toHaveBeenCalled();
    });

    it('should throw when recovery not found', async () => {
      prismaMock.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.approveRecovery({
          recoveryId: 'invalid-id',
          adminId: 'admin-1',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw when recovery not in IN_REVIEW status', async () => {
      prismaMock.recoveryRequest.findUnique.mockResolvedValue({
        id: 'recovery-1',
        walletId: 'wallet-1',
        status: RecoveryStatus.PENDING,
        requester: 'user-1',
        metadata: {},
      });

      await expect(
        service.approveRecovery({
          recoveryId: 'recovery-1',
          adminId: 'admin-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('rejectRecovery', () => {
    it('should reject recovery when in IN_REVIEW status', async () => {
      const recoveryId = 'recovery-1';
      const adminId = 'admin-1';

      prismaMock.recoveryRequest.findUnique.mockResolvedValue({
        id: recoveryId,
        walletId: 'wallet-1',
        status: RecoveryStatus.IN_REVIEW,
        requester: 'user-1',
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      prismaMock.recoveryRequest.update.mockResolvedValue({
        id: recoveryId,
        walletId: 'wallet-1',
        status: RecoveryStatus.REJECTED,
        requester: 'user-1',
        metadata: { rejectedBy: adminId },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.rejectRecovery({
        recoveryId,
        adminId,
        rejectionReason: 'Insufficient documentation',
      });

      expect(result.status).toBe(RecoveryStatus.REJECTED);
      expect(result.rejectedBy).toBe(adminId);
    });

    it('should throw when recovery not in IN_REVIEW status', async () => {
      prismaMock.recoveryRequest.findUnique.mockResolvedValue({
        id: 'recovery-1',
        walletId: 'wallet-1',
        status: RecoveryStatus.APPROVED,
        requester: 'user-1',
        metadata: {},
      });

      await expect(
        service.rejectRecovery({
          recoveryId: 'recovery-1',
          adminId: 'admin-1',
          rejectionReason: 'Reason',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getPendingRecoveries', () => {
    it('should return all IN_REVIEW recovery requests', async () => {
      prismaMock.recoveryRequest.findMany.mockResolvedValue([
        {
          id: 'recovery-1',
          walletId: 'wallet-1',
          status: RecoveryStatus.IN_REVIEW,
          requester: 'user-1',
          metadata: {},
          createdAt: new Date(),
        },
        {
          id: 'recovery-2',
          walletId: 'wallet-2',
          status: RecoveryStatus.IN_REVIEW,
          requester: 'user-2',
          metadata: {},
          createdAt: new Date(),
        },
      ]);

      const result = await service.getPendingRecoveries();

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe(RecoveryStatus.IN_REVIEW);
    });
  });

  describe('getRecoveryHistory', () => {
    it('should return recovery request details', async () => {
      prismaMock.recoveryRequest.findUnique.mockResolvedValue({
        id: 'recovery-1',
        walletId: 'wallet-1',
        status: RecoveryStatus.APPROVED,
        requester: 'user-1',
        metadata: { approvedBy: 'admin-1' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.getRecoveryHistory('recovery-1');

      expect(result.id).toBe('recovery-1');
      expect(result.status).toBe(RecoveryStatus.APPROVED);
    });

    it('should throw when recovery not found', async () => {
      prismaMock.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.getRecoveryHistory('invalid-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
