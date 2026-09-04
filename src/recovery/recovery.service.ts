import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';
import { RecoveryRequest } from './entities/recovery.entity';
import { PaginatedRecoveryDto } from './dto/paginated-recovery.dto';
import {
  RecoveryStatus,
  transitionRecoveryStatus,
  canTransitionRecoveryStatus,
} from './domain/recovery.model';

@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly recoveryRequestTtlMs: number;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.recoveryRequestTtlMs = this.configService.get<number>(
      'RECOVERY_REQUEST_TTL_MS',
      7 * 24 * 60 * 60 * 1000, // default TTL: 7 days
    );
  }

  /**
   * Expires stale recovery requests (older than the configured TTL) by moving
   * them to a terminal CANCELLED state so they can no longer be approved.
   */
  async expireStaleRequests(): Promise<number> {
    const cutoff = new Date(Date.now() - this.recoveryRequestTtlMs);

    const result = await this.prisma.recoveryRequest.updateMany({
      where: {
        status: {
          in: [RecoveryStatus.PENDING, RecoveryStatus.IN_REVIEW],
        },
        createdAt: { lt: cutoff },
      },
      data: { status: RecoveryStatus.CANCELLED },
    });

    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} stale recovery request(s)`);
    }

    return result.count;
  }

  private isExpired(recovery: { createdAt: Date }): boolean {
    return (
      Date.now() - recovery.createdAt.getTime() > this.recoveryRequestTtlMs
    );
  }

  async create(createRecoveryDto: CreateRecoveryDto): Promise<RecoveryRequest> {
    // Clear stale requests first so they do not block a new recovery flow.
    await this.expireStaleRequests();

    const existingActive = await this.prisma.recoveryRequest.findFirst({
      where: {
        walletId: createRecoveryDto.walletId,
        status: {
          notIn: [
            RecoveryStatus.REJECTED,
            RecoveryStatus.COMPLETED,
            RecoveryStatus.CANCELLED,
          ],
        },
      },
    });

    if (existingActive) {
      throw new BadRequestException(
        'An active recovery request already exists for this wallet',
      );
    }

    const wallet = await this.prisma.wallet.findUnique({
      where: { id: createRecoveryDto.walletId },
    });

    if (!wallet) {
      throw new BadRequestException('Wallet not found');
    }

    const recovery = await this.prisma.recoveryRequest.create({
      data: {
        walletId: createRecoveryDto.walletId,
        requester: createRecoveryDto.requester,
        metadata: createRecoveryDto.metadata,
      },
    });

    return this.mapPrismaToEntity(recovery);
  }

  async findAll(filters?: {
    walletId?: string;
    requester?: string;
    status?: RecoveryStatus;
    limit?: number;
    offset?: number;
    createdAt?: { gte?: Date; lte?: Date };
  }): Promise<PaginatedRecoveryDto> {
    const where: any = {};

    if (filters?.walletId) {
      where.walletId = filters.walletId;
    }

    if (filters?.requester) {
      where.requester = { contains: filters.requester, mode: 'insensitive' };
    }

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.createdAt) {
      where.createdAt = filters.createdAt;
    }

    const limit = filters?.limit ?? 20;
    const offset = filters?.offset ?? 0;

    const [recoveries, total] = await Promise.all([
      this.prisma.recoveryRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.recoveryRequest.count({ where }),
    ]);

    return {
      data: recoveries.map((r) => this.mapPrismaToEntity(r)),
      total,
      limit,
      offset,
      hasMore: offset + recoveries.length < total,
    };
  }

  async findOne(id: string): Promise<RecoveryRequest> {
    const recovery = await this.prisma.recoveryRequest.findUnique({
      where: { id },
    });

    if (!recovery) {
      throw new NotFoundException('Recovery request not found');
    }

    return this.mapPrismaToEntity(recovery);
  }

  async update(
    id: string,
    updateRecoveryDto: UpdateRecoveryDto,
  ): Promise<RecoveryRequest> {
    const recovery = await this.findOne(id);

    if (updateRecoveryDto.status) {
      // Block stale approvals: requests older than the TTL must be re-raised
      // before their keys are rotated.
      if (
        updateRecoveryDto.status === RecoveryStatus.APPROVED &&
        this.isExpired(recovery)
      ) {
        throw new BadRequestException(
          'Recovery request has expired and can no longer be approved',
        );
      }

      let updatedRecovery: RecoveryRequest;
      try {
        updatedRecovery = transitionRecoveryStatus(
          recovery,
          updateRecoveryDto.status,
        );
      } catch (e) {
        throw new BadRequestException(
          e instanceof Error ? e.message : 'Invalid recovery status transition',
        );
      }

      const result = await this.prisma.recoveryRequest.update({
        where: { id },
        data: { status: updatedRecovery.status },
      });

      return this.mapPrismaToEntity(result);
    }

    return recovery;
  }

  async initiate(id: string): Promise<RecoveryRequest> {
    const recovery = await this.findOne(id);

    if (recovery.status !== RecoveryStatus.PENDING) {
      throw new BadRequestException(
        `Recovery request cannot be initiated from status ${recovery.status}; it must be PENDING`,
      );
    }

    const transitioned = transitionRecoveryStatus(
      recovery,
      RecoveryStatus.IN_REVIEW,
    );

    const result = await this.prisma.recoveryRequest.update({
      where: { id },
      data: { status: transitioned.status },
    });

    return this.mapPrismaToEntity(result);
  }

  /**
   * Cancels a recovery request by transitioning it to CANCELLED status.
   * Only requests in PENDING, IN_REVIEW, or APPROVED state can be cancelled.
   *
   * @param id  Recovery request UUID
   * @returns   Updated recovery request with status CANCELLED
   * @throws    NotFoundException   if the request does not exist
   * @throws    BadRequestException if the transition is not allowed
   */
  async cancel(id: string): Promise<RecoveryRequest> {
    const recovery = await this.findOne(id);

    if (!canTransitionRecoveryStatus(recovery.status, RecoveryStatus.CANCELLED)) {
      throw new BadRequestException(
        `Recovery request cannot be cancelled from status ${recovery.status}. ` +
          `Only PENDING, IN_REVIEW, or APPROVED requests can be cancelled.`,
      );
    }

    const result = await this.prisma.recoveryRequest.update({
      where: { id },
      data: { status: RecoveryStatus.CANCELLED },
    });

    return this.mapPrismaToEntity(result);
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.recoveryRequest.delete({
      where: { id },
    });
  }

  async getWalletRecoveryStatus(walletId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const recovery = await this.prisma.recoveryRequest.findFirst({
      where: {
        walletId,
        status: {
          notIn: [
            RecoveryStatus.REJECTED,
            RecoveryStatus.COMPLETED,
            RecoveryStatus.CANCELLED,
          ],
        },
        createdAt: { gte: new Date(Date.now() - this.recoveryRequestTtlMs) },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      walletId,
      hasActiveRecovery: !!recovery,
      currentStatus: recovery?.status as RecoveryStatus,
      recoveryRequestId: recovery?.id,
      lastUpdatedAt: recovery?.updatedAt,
    };
  }

  private mapPrismaToEntity(prismaRecovery: any): RecoveryRequest {
    return {
      id: prismaRecovery.id,
      walletId: prismaRecovery.walletId,
      requester: prismaRecovery.requester,
      status: prismaRecovery.status as RecoveryStatus,
      metadata: prismaRecovery.metadata,
      createdAt: prismaRecovery.createdAt,
      updatedAt: prismaRecovery.updatedAt,
    };
  }
}
