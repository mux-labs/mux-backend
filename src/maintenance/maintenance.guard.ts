import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

    const maintenanceState = await this.getMaintenanceState();
    
    if (maintenanceState.enabled) {
      this.logger.warn(
        `Maintenance mode enabled - rejecting ${method} request to ${request.url}`,
      );
      
      const error = new ServiceUnavailableException({
        code: 'MAINTENANCE_MODE',
        message: maintenanceState.message || 'Service temporarily unavailable for maintenance',
        retryAfter: maintenanceState.retryAfterSeconds,
      });
      
      // Set Retry-After header if configured
      if (maintenanceState.retryAfterSeconds) {
        request.res?.setHeader?.('Retry-After', maintenanceState.retryAfterSeconds.toString());
      }
      
      throw error;
    }

    return true;
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
    } catch (error) {
      this.logger.error('Failed to read maintenance state, failing open', error);
      // Fail open for read errors - don't block requests if we can't read maintenance state
      return { enabled: false };
    }
  }
}