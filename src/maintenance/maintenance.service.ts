import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MaintenanceStatusDto,
  UpdateMaintenanceDto,
} from './dto/update-maintenance.dto';

const GLOBAL_MAINTENANCE_ID = 'global';

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(): Promise<MaintenanceStatusDto> {
    const state = await this.prisma.maintenanceState.findUnique({
      where: { id: GLOBAL_MAINTENANCE_ID },
    });

    if (!state) {
      return {
        enabled: false,
        message: null,
        retryAfterSeconds: null,
        enabledAt: null,
        updatedAt: null,
      };
    }

    return {
      enabled: state.enabled,
      message: state.message,
      retryAfterSeconds: state.retryAfterSeconds,
      enabledAt: state.enabledAt,
      updatedAt: state.updatedAt,
    };
  }

  async updateStatus(
    update: UpdateMaintenanceDto,
    updatedBy: string,
  ): Promise<MaintenanceStatusDto> {
    const state = await this.prisma.maintenanceState.upsert({
      where: { id: GLOBAL_MAINTENANCE_ID },
      create: {
        id: GLOBAL_MAINTENANCE_ID,
        enabled: update.enabled,
        message: update.message ?? null,
        retryAfterSeconds: update.retryAfterSeconds ?? null,
        enabledAt: update.enabled ? new Date() : null,
        updatedBy,
      },
      update: {
        enabled: update.enabled,
        message: update.message ?? null,
        retryAfterSeconds: update.retryAfterSeconds ?? null,
        enabledAt: update.enabled ? new Date() : null,
        updatedBy,
      },
    });

    return {
      enabled: state.enabled,
      message: state.message,
      retryAfterSeconds: state.retryAfterSeconds,
      enabledAt: state.enabledAt,
      updatedAt: state.updatedAt,
    };
  }
}
