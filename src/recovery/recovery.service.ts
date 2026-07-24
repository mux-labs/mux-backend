import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';
import { RecoveryRequest } from './entities/recovery.entity';
import { PaginatedRecoveryDto } from './dto/paginated-recovery.dto';
import {
  RecoveryStatus,
  transitionRecoveryStatus,
} from './domain/recovery.model';

@Injectable()
export class RecoveryService {
  constructor(private prisma: PrismaService) {}

  async create(createRecoveryDto: CreateRecoveryDto): Promise<RecoveryRequest> {
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

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.recoveryRequest.delete({
      where: { id },
    });
  }

  async initiate(id: string): Promise<RecoveryRequest> {
    const recovery = await this.findOne(id);

    if (recovery.status !== RecoveryStatus.PENDING) {
      throw new BadRequestException(
        'Recovery request must be in PENDING status to initiate',
      );
    }

    const result = await this.prisma.recoveryRequest.update({
      where: { id },
      data: { status: RecoveryStatus.IN_REVIEW },
    });

    return this.mapPrismaToEntity(result);
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
