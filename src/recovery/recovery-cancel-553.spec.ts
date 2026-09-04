/**
 * Unit tests for the recovery cancel endpoint (#553).
 *
 * Covers:
 *  - RecoveryService.cancel: PENDING → CANCELLED (success)
 *  - RecoveryService.cancel: IN_REVIEW → CANCELLED (success)
 *  - RecoveryService.cancel: APPROVED → CANCELLED (success)
 *  - RecoveryService.cancel: COMPLETED → error (terminal state)
 *  - RecoveryService.cancel: REJECTED → error (terminal state)
 *  - RecoveryService.cancel: CANCELLED → error (already cancelled)
 *  - RecoveryService.cancel: NotFoundException for unknown ID
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecoveryStatus } from './domain/recovery.model';

function makeRecovery(status: RecoveryStatus) {
  return {
    id: '660e8400-e29b-41d4-a716-446655440001',
    walletId: '550e8400-e29b-41d4-a716-446655440000',
    requester: 'user_abc123',
    status,
    metadata: null,
    createdAt: new Date('2026-06-29T12:00:00.000Z'),
    updatedAt: new Date('2026-06-29T12:00:00.000Z'),
  };
}

describe('RecoveryService – cancel endpoint (#553)', () => {
  let service: RecoveryService;
  let prisma: any;

  const RECOVERY_ID = '660e8400-e29b-41d4-a716-446655440001';

  beforeEach(async () => {
    prisma = {
      recoveryRequest: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      wallet: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecoveryService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<RecoveryService>(RecoveryService);
  });

  // ── Success paths ────────────────────────────────────────────────────────────

  describe('allowed cancellations', () => {
    const cancellableStatuses = [
      RecoveryStatus.PENDING,
      RecoveryStatus.IN_REVIEW,
      RecoveryStatus.APPROVED,
    ];

    for (const status of cancellableStatuses) {
      it(`cancels a ${status} request`, async () => {
        const cancelled = { ...makeRecovery(status), status: RecoveryStatus.CANCELLED };
        prisma.recoveryRequest.findUnique.mockResolvedValue(makeRecovery(status));
        prisma.recoveryRequest.update.mockResolvedValue(cancelled);

        const result = await service.cancel(RECOVERY_ID);

        expect(result.status).toBe(RecoveryStatus.CANCELLED);
        expect(prisma.recoveryRequest.update).toHaveBeenCalledWith({
          where: { id: RECOVERY_ID },
          data: { status: RecoveryStatus.CANCELLED },
        });
      });
    }
  });

  // ── Failure paths ────────────────────────────────────────────────────────────

  describe('disallowed cancellations', () => {
    const terminalStatuses = [
      RecoveryStatus.COMPLETED,
      RecoveryStatus.REJECTED,
      RecoveryStatus.CANCELLED,
    ];

    for (const status of terminalStatuses) {
      it(`throws BadRequestException when status is ${status}`, async () => {
        prisma.recoveryRequest.findUnique.mockResolvedValue(makeRecovery(status));

        await expect(service.cancel(RECOVERY_ID)).rejects.toThrow(
          BadRequestException,
        );

        expect(prisma.recoveryRequest.update).not.toHaveBeenCalled();
      });
    }

    it('throws NotFoundException when the recovery request does not exist', async () => {
      prisma.recoveryRequest.findUnique.mockResolvedValue(null);

      await expect(service.cancel('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── Error message quality ────────────────────────────────────────────────────

  it('error message mentions the current status when cancellation is disallowed', async () => {
    prisma.recoveryRequest.findUnique.mockResolvedValue(
      makeRecovery(RecoveryStatus.COMPLETED),
    );

    try {
      await service.cancel(RECOVERY_ID);
      fail('Expected BadRequestException');
    } catch (err: any) {
      expect(err.message).toContain('COMPLETED');
    }
  });
});
