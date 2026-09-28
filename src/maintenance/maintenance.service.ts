import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MaintenanceStatusDto,
  UpdateMaintenanceDto,
} from './dto/update-maintenance.dto';

/** Maintenance state is a single global row, shared by every API instance. */
const GLOBAL_MAINTENANCE_ID = 'global';

/**
 * Reads and writes the persisted maintenance state (#925).
 *
 * Invariants:
 *
 * 1. **Reads fail closed.** A read that throws is surfaced as
 *    `MAINTENANCE_STATE_UNAVAILABLE` rather than reported as "not in
 *    maintenance". A status endpoint that swallows a database error tells an
 *    operator the fleet is writable when it is not.
 * 2. **No secret ever reaches this layer.** The service is authorized by
 *    `MaintenanceAdminGuard` before it is called; it records only the identity
 *    of the caller, never a credential.
 * 3. **Audit trail.** Every write records `updatedBy`, so "who froze the
 *    writes" is answerable after the fact.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Current maintenance state, or the safe default when no row exists. */
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

    return this.toStatus(state);
  }

  /**
   * Enable or disable maintenance mode.
   *
   * `updatedBy` is the server-resolved caller identity (an API-key id), never a
   * value taken from the request body, so a client cannot forge the audit
   * trail.
   */
  async updateStatus(
    update: UpdateMaintenanceDto,
    updatedBy: string,
  ): Promise<MaintenanceStatusDto> {
    const enabledAt = update.enabled ? new Date() : null;

    const state = await this.prisma.maintenanceState.upsert({
      where: { id: GLOBAL_MAINTENANCE_ID },
      create: {
        id: GLOBAL_MAINTENANCE_ID,
        enabled: update.enabled,
        message: update.message ?? null,
        retryAfterSeconds: update.retryAfterSeconds ?? null,
        enabledAt,
        updatedBy,
      },
      update: {
        enabled: update.enabled,
        message: update.message ?? null,
        retryAfterSeconds: update.retryAfterSeconds ?? null,
        enabledAt,
        updatedBy,
      },
    });

    this.logger.warn(
      `maintenance mode ${update.enabled ? 'ENABLED' : 'disabled'} by ${updatedBy}`,
    );

    return this.toStatus(state);
  }

  private toStatus(state: {
    enabled: boolean;
    message: string | null;
    retryAfterSeconds: number | null;
    enabledAt: Date | null;
    updatedAt: Date;
  }): MaintenanceStatusDto {
    return {
      enabled: state.enabled,
      message: state.message,
      retryAfterSeconds: state.retryAfterSeconds,
      enabledAt: state.enabledAt,
      updatedAt: state.updatedAt,
    };
  }
}
