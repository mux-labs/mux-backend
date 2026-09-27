import { Injectable, Logger } from '@nestjs/common';
import { IdempotentUserService } from './idempotent-user.service';
import { MetricsService } from '../common/metrics/metrics.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly idempotentUserService: IdempotentUserService,
    private readonly metricsService: MetricsService,
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
}
