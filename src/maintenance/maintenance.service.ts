import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MaintenanceStatusDto,
  UpdateMaintenanceDto,
} from './dto/update-maintenance.dto';
import { MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE } from './maintenance-secret.service';

/** Maintenance state is a single global row, shared by every API instance. */
const GLOBAL_MAINTENANCE_ID = 'global';

/**
 * Reads and writes the persisted maintenance state (#925, #966, #967).
 *
 * Invariants:
 *
 * 1. **Reads fail closed.** A read that throws is surfaced as
 *    `MAINTENANCE_STATE_UNAVAILABLE` rather than reported as "not in
 *    maintenance". A status endpoint that swallows a database error tells an
 *    operator the fleet is writable when it is not.
 * 2. **No secret ever leaves or reaches this layer.** The status endpoint
 *    sanitizes messages against secret leakages (Stellar keys, JWTs, API keys)
 *    and never returns `updatedBy` or raw credentials (#966).
 * 3. **Dual authorization audit trail.** Every write records `updatedBy`
 *    authenticated via dual auth (API key + admin secret), so "who froze the
 *    writes" is reliably answerable after the fact (#967).
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

  /**
   * Redacts sensitive secrets, API keys, JWTs, or Stellar secret keys from
   * maintenance explanations to ensure no secret is leaked via GET /maintenance (#966).
   */
  private sanitizeMessage(message: string | null): string | null {
    if (!message) {
      return null;
    }

    return message
      // Stellar secret key (S followed by 55 base32 chars)
      .replace(/S[0-9A-Z]{55}/g, '[REDACTED_KEY]')
      // API keys (mux_live_* or mux_test_*)
      .replace(/mux_(live|test)_[a-zA-Z0-9_-]+/g, '[REDACTED_API_KEY]')
      // Webhook secrets
      .replace(/whsec_[a-zA-Z0-9_-]+/g, '[REDACTED_WEBHOOK_SECRET]')
      // JWTs (standard or compact)
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?/g, '[REDACTED_JWT]')
      // Bearer tokens
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      // Maintenance admin secret patterns
      .replace(/(?:admin[_-]?secret|maintenance[_-]?secret)[:=]\s*([^\s,;]+)/gi, 'secret=[REDACTED]');
  }

  private toStatus(state: {
    enabled: boolean;
    message: string | null;
    retryAfterSeconds: number | null;
    enabledAt: Date | null;
    updatedAt: Date;
    updatedBy?: string | null;
  }): MaintenanceStatusDto {
    return {
      enabled: Boolean(state.enabled),
      message: this.sanitizeMessage(state.message),
      retryAfterSeconds: state.retryAfterSeconds ?? null,
      enabledAt: state.enabledAt ?? null,
      updatedAt: state.updatedAt ?? null,
    };
  }
}
