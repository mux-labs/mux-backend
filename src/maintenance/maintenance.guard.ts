import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE } from './maintenance-secret.service';
import { ALLOW_DURING_MAINTENANCE } from './maintenance.decorator';

/**
 * Guard that blocks mutating requests when maintenance mode is enabled.
 * Reads maintenance state from the database.
 *
 * Fail-closed: if the state cannot be read (DB outage, query error), mutating
 * requests are rejected with `503` rather than being allowed through. Allowing
 * writes while the state is unknown is how a partial outage turns into a
 * money-path incident — an operator who already flipped the switch must not
 * have it silently ignored because the database blipped.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceGuard.name);
  private cachedState: {
    enabled: boolean;
    retryAfterSeconds?: number;
    message?: string;
  } | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 seconds cache

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only check maintenance mode for mutating methods
    const request = context.switchToHttp().getRequest();
    const method = request.method?.toUpperCase();

    const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!mutatingMethods.includes(method)) {
      return true;
    }

    // The maintenance toggle is the control that turns maintenance mode off.
    // Blocking it here would mean an operator could freeze every write and
    // then be unable to unfreeze it, so routes that opt in are exempt. They
    // carry their own authentication (see `MaintenanceAdminGuard`).
    if (this.isAllowedDuringMaintenance(context)) {
      return true;
    }

    const maintenanceState = await this.getMaintenanceState();

    // Dependency outage: refuse the write rather than guessing the state.
    if (maintenanceState.unavailable) {
      this.logger.error(
        `Maintenance state unavailable - rejecting ${method} request to ${request.url} (${MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE})`,
      );

      throw new ServiceUnavailableException({
        code: MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE,
        message: 'Service temporarily unavailable',
      });
    }

    if (maintenanceState.enabled) {
      this.logger.warn(
        `Maintenance mode enabled - rejecting ${method} request to ${request.url}`,
      );

      const error = new ServiceUnavailableException({
        code: 'MAINTENANCE_MODE',
        message:
          maintenanceState.message ||
          'Service temporarily unavailable for maintenance',
        retryAfter: maintenanceState.retryAfterSeconds,
      });

      // Set Retry-After header if configured
      if (maintenanceState.retryAfterSeconds) {
        request.res?.setHeader?.(
          'Retry-After',
          maintenanceState.retryAfterSeconds.toString(),
        );
      }

      throw error;
    }

    return true;
  }

  /**
   * Whether the handler (or controller) opted into running while maintenance
   * mode is enabled. Defaults to `false`, so a new route is never accidentally
   * exempt.
   */
  private isAllowedDuringMaintenance(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_MAINTENANCE, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private async getMaintenanceState(): Promise<{
    enabled: boolean;
    retryAfterSeconds?: number;
    message?: string;
    /** True when the state could not be read; caller must fail closed. */
    unavailable?: boolean;
  }> {
    const now = Date.now();

    // Return cached state if valid
    if (this.cachedState && now < this.cacheExpiresAt) {
      return this.cachedState;
    }

    try {
      const state = await this.prisma.maintenanceState.findUnique({
        where: { id: 'global' },
      });

      this.cachedState = {
        enabled: state?.enabled ?? false,
        retryAfterSeconds: state?.retryAfterSeconds ?? undefined,
        message: state?.message ?? undefined,
      };
      this.cacheExpiresAt = now + this.CACHE_TTL_MS;

      return this.cachedState;
    } catch (error) {
      // Fail CLOSED on a dependency outage: an unknown maintenance state must
      // not be reported as "not in maintenance", or writes would flow while an
      // operator believes the system is frozen. The failure is deliberately
      // not cached, so recovery takes effect as soon as the DB returns.
      this.logger.error(
        `Failed to read maintenance state - failing closed (${MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE})`,
        error instanceof Error ? error.stack : undefined,
      );
      return { enabled: true, unavailable: true };
    }
  }
}
