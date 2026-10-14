import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { IdempotentUserService } from './idempotent-user.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly idempotentUserService: IdempotentUserService,
    private readonly metricsService: MetricsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * Find an existing user by authId or create a new one.
   * Delegates to IdempotentUserService for the actual logic.
   */
  async findOrCreateUser(
    authId: string,
    actorContext: any,
    idempotencyKey?: string,
    requestContext?: any,
  ) {
    return this.idempotentUserService.findOrCreateUser(
      authId,
      actorContext,
      idempotencyKey,
      requestContext,
    );
  }

  /**
   * Find an existing user by authId.
   */
  async findUserByAuthId(authId: string) {
    return this.idempotentUserService.findUserByAuthId(authId);
  }

  /**
   * Soft-deletes a user by id (#968).
   *
   * Invariants:
   * 1. Idempotent: Replaying deletion on an already-deleted user returns the terminal state.
   * 2. Fail-closed: Database failures throw and never report success.
   * 3. Sanitized: Sensitive data (IP, User-Agent, secrets) are redacted.
   */
  async remove(id: string) {
    if (!this.prisma) {
      throw new Error('Database service unavailable');
    }

    const existing = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`User ${id} not found`);
    }

    if (existing.deletedAt) {
      return this.sanitizeUser(existing);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        status: 'DISABLED',
        deletedAt: new Date(),
      },
    });

    this.metricsService?.incrementCounter('user.deletion.success', 1);

    return this.sanitizeUser(updated);
  }

  private sanitizeUser(user: any) {
    const {
      lastLoginIp,
      lastLoginUserAgent,
      ...safe
    } = user;
    return safe;
  }
}
