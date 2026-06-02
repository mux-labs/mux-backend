import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';
import { RecoveryRequest } from './entities/recovery.entity';
import {
  RecoveryStatus,
  transitionRecoveryStatus,
} from './domain/recovery.model';

@Injectable()
export class RecoveryService {
  constructor(private prisma: PrismaService) {}

  async create(createRecoveryDto: CreateRecoveryDto): Promise<RecoveryRequest> {
    // Check for existing active recovery
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

    // Verify wallet exists
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

    return {
      id: recovery.id,
      walletId: recovery.walletId,
      requester: recovery.requester,
      status: recovery.status as RecoveryStatus,
      metadata: recovery.metadata,
      createdAt: recovery.createdAt,
      updatedAt: recovery.updatedAt,
    };
  }

  async findAll(): Promise<RecoveryRequest[]> {
    const recoveries = await this.prisma.recoveryRequest.findMany();
    return recoveries.map((r) => ({
      id: r.id,
      walletId: r.walletId,
      requester: r.requester,
      status: r.status as RecoveryStatus,
      metadata: r.metadata,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async findOne(id: string): Promise<RecoveryRequest> {
    const recovery = await this.prisma.recoveryRequest.findUnique({
      where: { id },
    });

    if (!recovery) {
      throw new NotFoundException('Recovery request not found');
    }

    return {
      id: recovery.id,
      walletId: recovery.walletId,
      requester: recovery.requester,
      status: recovery.status as RecoveryStatus,
      metadata: recovery.metadata,
      createdAt: recovery.createdAt,
      updatedAt: recovery.updatedAt,
    };
  }

  async update(
    id: string,
    updateRecoveryDto: UpdateRecoveryDto,
  ): Promise<RecoveryRequest> {
    const recovery = await this.findOne(id);

    if (updateRecoveryDto.status) {
      // Enforce state transition
      const updatedRecovery = transitionRecoveryStatus(
        recovery,
        updateRecoveryDto.status,
      );

      const result = await this.prisma.recoveryRequest.update({
        where: { id },
        data: { status: updatedRecovery.status },
      });

      return {
        id: result.id,
        walletId: result.walletId,
        requester: result.requester,
        status: result.status as RecoveryStatus,
        metadata: result.metadata,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      };
    }

    // If no status update, return current
    return recovery;
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id); // Check exists
    await this.prisma.recoveryRequest.delete({
      where: { id },
    });
  }
}
