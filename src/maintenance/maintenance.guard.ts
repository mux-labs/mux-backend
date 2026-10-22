import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/** Retry hint sent with every maintenance 503 when the row has no `retryAfterSeconds`. */
export const DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS = 60;

/**
 * Guard that blocks mutating requests when maintenance mode is enabled.
 * Reads maintenance state from the database.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceGuard.name);
  private cachedState: { enabled: boolean; retryAfterSeconds?: number; message?: string } | null = null;
  private cacheExpiresAt = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 seconds cache

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only check maintenance mode for mutating methods
    const request = context.switchToHttp().getRequest();
    const method = request.method?.toUpperCase();
    
    const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (!mutatingMethods.includes(method)) {
      return true;
    }

    const wasEnabled = this.cachedState?.enabled ?? false;
    const maintenanceState = await this.getMaintenanceState();

    if (maintenanceState.enabled) {
      // Log once per transition into maintenance, not once per rejected request.
      // Log the route template only: no resource ids or query string.
      if (!wasEnabled) {
        this.logger.warn(
          `Maintenance mode enabled - rejecting ${method} request to ${request.route?.path ?? request.path}`,
        );
      }
      
      const retryAfterSeconds =
        maintenanceState.retryAfterSeconds ?? DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS;
      const error = new ServiceUnavailableException({
        code: 'MAINTENANCE_MODE',
        message: maintenanceState.message || 'Service temporarily unavailable for maintenance',
        retryAfter: retryAfterSeconds,
      });

      // Set Retry-After on the response the exception filter writes to
      context.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryAfterSeconds));

      throw error;
    }

    return true;
  }

  /**
   * Drops the cached maintenance state so the next request re-reads it from the database.
   * Call after the persisted state changes so this instance does not serve a stale value.
   */
  invalidate(): void {
    this.cachedState = null;
    this.cacheExpiresAt = 0;
  }

  private async getMaintenanceState(): Promise<{
    enabled: boolean;
    retryAfterSeconds?: number;
    message?: string;
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
    } catch {
      // Log a stable message only: the raw Prisma error can carry the connection string.
      this.logger.error('Failed to read maintenance state, failing closed');
      // Fail closed: an unreadable persisted state must not be reported as disabled.
      // Not cached, so the next request retries the read.
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE_MODE',
        message: 'Service temporarily unavailable for maintenance',
        retryAfter: DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS,
      });
    }
  }
}