import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import {
  RecoveryStatus,
  canTransitionRecoveryStatus,
  transitionRecoveryStatus,
} from './domain/recovery.model';

export interface AdminApprovalRequest {
  recoveryId: string;
  adminId: string;
  approvalNotes?: string;
}

export interface AdminRejectionRequest {
  recoveryId: string;
  adminId: string;
  rejectionReason: string;
}

@Injectable()
export class AdminRecoveryService {
  private readonly logger = new Logger(AdminRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
  ) {}

  async approveRecovery(request: AdminApprovalRequest) {
    this.logger.log(
      `Admin ${request.adminId} approving recovery ${request.recoveryId}`,
    );

    // Fetch the recovery request
    const recovery = await this.prisma.recoveryRequest.findUnique({
      where: { id: request.recoveryId },
    });

    if (!recovery) {
      throw new NotFoundException('Recovery request not found');
    }

    // Verify it's in IN_REVIEW status
    if (recovery.status !== RecoveryStatus.IN_REVIEW) {
      throw new BadRequestException(
        `Recovery cannot be approved from ${recovery.status} status. Must be IN_REVIEW.`,
      );
    }

    // Verify transition is allowed
    if (!canTransitionRecoveryStatus(recovery.status, RecoveryStatus.APPROVED)) {
      throw new BadRequestException(
        `Invalid status transition: ${recovery.status} -> APPROVED`,
      );
    }

    // Rotate custody material before completing the approval. If rotation fails,
    // the request remains IN_REVIEW and can be retried safely.
    const rotation = await this.walletsService.rotateWalletKey(recovery.walletId);

    const updated = await this.prisma.recoveryRequest.update({
      where: { id: request.recoveryId },
      data: {
        status: RecoveryStatus.COMPLETED,
        metadata: {
          ...recovery.metadata,
          approvedBy: request.adminId,
          approvedAt: new Date().toISOString(),
          approvalNotes: request.approvalNotes,
          recoveryAction: 'KEY_ROTATED',
          successorPublicKey: rotation.wallet.publicKey,
          secretVersion: rotation.wallet.secretVersion,
        },
      },
    });

    this.logger.log(`Recovery ${request.recoveryId} approved by ${request.adminId}`);

    return {
      id: updated.id,
      walletId: updated.walletId,
      status: updated.status,
      approvedBy: request.adminId,
      approvedAt: new Date(),
    };
  }

  async rejectRecovery(request: AdminRejectionRequest) {
    this.logger.log(
      `Admin ${request.adminId} rejecting recovery ${request.recoveryId}`,
    );

    // Fetch the recovery request
    const recovery = await this.prisma.recoveryRequest.findUnique({
      where: { id: request.recoveryId },
    });

    if (!recovery) {
      throw new NotFoundException('Recovery request not found');
    }

    // Verify it's in IN_REVIEW status
    if (recovery.status !== RecoveryStatus.IN_REVIEW) {
      throw new BadRequestException(
        `Recovery cannot be rejected from ${recovery.status} status. Must be IN_REVIEW.`,
      );
    }

    // Verify transition is allowed
    if (!canTransitionRecoveryStatus(recovery.status, RecoveryStatus.REJECTED)) {
      throw new BadRequestException(
        `Invalid status transition: ${recovery.status} -> REJECTED`,
      );
    }

    // Update recovery status to REJECTED
    const updated = await this.prisma.recoveryRequest.update({
      where: { id: request.recoveryId },
      data: {
        status: RecoveryStatus.REJECTED,
        metadata: {
          ...recovery.metadata,
          rejectedBy: request.adminId,
          rejectedAt: new Date().toISOString(),
          rejectionReason: request.rejectionReason,
        },
      },
    });

    this.logger.log(`Recovery ${request.recoveryId} rejected by ${request.adminId}`);

    return {
      id: updated.id,
      walletId: updated.walletId,
      status: updated.status,
      rejectedBy: request.adminId,
      rejectedAt: new Date(),
    };
  }

  async getPendingRecoveries() {
    this.logger.log('Fetching pending recovery requests');

    const pendingRecoveries = await this.prisma.recoveryRequest.findMany({
      where: {
        status: RecoveryStatus.IN_REVIEW,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return pendingRecoveries.map((r) => ({
      id: r.id,
      walletId: r.walletId,
      requester: r.requester,
      status: r.status,
      createdAt: r.createdAt,
      metadata: r.metadata,
    }));
  }

  async getRecoveryHistory(recoveryId: string) {
    const recovery = await this.prisma.recoveryRequest.findUnique({
      where: { id: recoveryId },
    });

    if (!recovery) {
      throw new NotFoundException('Recovery request not found');
    }

    return {
      id: recovery.id,
      walletId: recovery.walletId,
      requester: recovery.requester,
      status: recovery.status,
      createdAt: recovery.createdAt,
      updatedAt: recovery.updatedAt,
      metadata: recovery.metadata,
    };
  }
}
