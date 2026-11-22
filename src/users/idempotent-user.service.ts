import { Injectable, Logger, ConflictException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { randomUUID } from 'crypto';

/**
 * Stable error codes for idempotent user find-or-create operations.
 * Clients should branch on these codes, not on human-readable messages.
 */
export const IdempotentUserErrorCode = {
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INVALID_INPUT: 'INVALID_INPUT',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type IdempotentUserErrorCode =
  (typeof IdempotentUserErrorCode)[keyof typeof IdempotentUserErrorCode];

/**
 * Actor context for authorization. Deny-by-default: only the wallet owner
 * (or an explicitly authorized delegate/guardian) may perform find-or-create.
 */
export interface ActorContext {
  actorId: string;
  actorType: 'owner' | 'delegate' | 'guardian' | 'api_key' | 'jwt';
  roles: string[];
}

/**
 * Request context captured from the HTTP layer for logging and metrics.
 * Never includes secrets, raw key material, or PII beyond what is needed.
 */
export interface RequestContext {
  requestId: string;
  actorId?: string;
  actorType?: string;
  idempotencyKey?: string;
}

/**
 * Result of a find-or-create operation.
 */
export interface FindOrCreateUserResult {
  user: UserRecord;
  created: boolean;
  authId: string;
  userId: string;
  network: string;
  error?: string;
  errorCode?: string;
}

export interface UserRecord {
  id: string;
  authId: string;
  email: string | null;
  displayName: string | null;
  status: string;
  authProvider: string;
  defaultNetwork: string | null;
  createdAt: Date | null;
  updatedAt: Date;
}

/**
 * Idempotent user find-or-create service.
 *
 * This service is the single source of truth for user find-or-create
 * operations. It handles:
 * - Finding an existing user by authId
 * - Creating a new user if not found
 * - Idempotency key caching to prevent duplicate creates
 * - Race condition handling (P2002 unique constraint violations)
 * - Fail-closed behavior on dependency outages
 *
 * Invariants:
 * - If `idempotencyKey` is provided and a previous request with the same
 *   key completed successfully, the cached result is returned immediately.
 * - If `idempotencyKey` is provided and a previous request with the same
 *   key failed, the failure is replayed (same error returned).
 * - If `idempotencyKey` is omitted, the operation is non-idempotent and
 *   a 400 is returned.
 * - Concurrent creates for the same authId are handled via P2002 retry.
 * - Authz failures always return 403.
 * - DB outages always return 503.
 */
@Injectable()
export class IdempotentUserService {
  private readonly logger = new Logger(IdempotentUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
  ) {}

  /**
   * Find an existing user by authId or create a new one.
   *
   * @param authId - The authenticated user's stable identifier
   * @param actorContext - The actor performing the operation
   * @param idempotencyKey - Optional idempotency key for replay protection
   * @param requestContext - Context for logging/metrics
   * @returns The found or created user record
   */
  async findOrCreateUser(
    authId: string,
    actorContext: ActorContext,
    idempotencyKey?: string,
    requestContext?: RequestContext,
  ): Promise<FindOrCreateUserResult> {
    const logMeta = {
      requestId: requestContext?.requestId ?? 'unknown',
      authId: this.redactAuthId(authId),
      actorId: requestContext?.actorId,
      idempotencyKey: requestContext?.idempotencyKey,
    };

    this.logger.log('findOrCreateUser called', logMeta);

    // Authz: deny-by-default
    this.enforceAuthorization(actorContext);

    // Idempotency: require key for safe replay
    if (!idempotencyKey) {
      this.metricsService.incrementCounter('users.find_or_create.missing_idempotency_key', 1);
      throw new BadRequestException({
        errorCode: IdempotentUserErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        message: 'An idempotency key is required for user find-or-create',
      });
    }

    // Validate input
    this.validateAuthId(authId);

    // Check idempotency cache first
    const cachedResult = await this.getIdempotencyCache(idempotencyKey, authId);
    if (cachedResult) {
      this.logger.log('Idempotent cache hit', {
        ...logMeta,
        idempotencyKey,
      });
      this.metricsService.incrementCounter(
        'users.find_or_create.idempotent_cache_hit',
        1,
      );
      return cachedResult as FindOrCreateUserResult;
    }

    // Try to find existing user first
    let existingUser = await this.findUserByAuthId(authId);

    if (existingUser) {
      const result: FindOrCreateUserResult = {
        user: existingUser,
        created: false,
        authId: existingUser.authId,
        userId: existingUser.id,
        network: existingUser.defaultNetwork ?? 'TESTNET',
      };

      // Cache the result for idempotency
      await this.setIdempotencyCache(idempotencyKey, authId, result);

      this.metricsService.incrementCounter('users.find_or_create.found', 1);
      this.logger.log('findOrCreateUser found existing user', {
        ...logMeta,
        userId: result.userId,
      });

      return result;
    }

    // Create new user with race condition handling
    const result = await this.createUserWithRaceHandling(
      authId,
      actorContext,
      idempotencyKey,
      logMeta,
    );

    return result;
  }

  /**
   * Find a user by their authId.
   */
  async findUserByAuthId(authId: string): Promise<UserRecord | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { authId },
      });

      if (!user) {
        return null;
      }

      return {
        id: user.id,
        authId: user.authId,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        authProvider: user.authProvider,
        defaultNetwork: user.defaultNetwork,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
    } catch (error) {
      this.logger.error('DB lookup failed', {
        authId: this.redactAuthId(authId),
        error: error.message,
      });
      throw new ServiceUnavailableException({
        errorCode: IdempotentUserErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'User lookup temporarily unavailable',
      });
    }
  }

  /**
   * Create a new user, handling race conditions (P2002 unique constraint
   * violations) when concurrent requests try to create the same user.
   */
  private async createUserWithRaceHandling(
    authId: string,
    actorContext: ActorContext,
    idempotencyKey: string,
    logMeta: Record<string, unknown>,
  ): Promise<FindOrCreateUserResult> {
    try {
      const newUser = await this.prisma.user.create({
        data: {
          authId,
          email: null,
          displayName: null,
          status: 'ACTIVE',
          authProvider: 'UNKNOWN',
          defaultNetwork: 'TESTNET',
          createdBy: actorContext.actorId,
          createdByType: actorContext.actorType,
        },
      });

      const result: FindOrCreateUserResult = {
        user: {
          id: newUser.id,
          authId: newUser.authId,
          email: newUser.email,
          displayName: newUser.displayName,
          status: newUser.status,
          authProvider: newUser.authProvider,
          defaultNetwork: newUser.defaultNetwork,
          createdAt: newUser.createdAt,
          updatedAt: newUser.updatedAt,
        },
        created: true,
        authId: newUser.authId,
        userId: newUser.id,
        network: newUser.defaultNetwork ?? 'TESTNET',
      };

      await this.setIdempotencyCache(idempotencyKey, authId, result);

      this.metricsService.incrementCounter('users.find_or_create.created', 1);
      this.logger.log('findOrCreateUser created user', {
        ...logMeta,
        userId: result.userId,
      });

      return result;
    } catch (error) {
      // P2002: unique constraint violation — another request won the race.
      if (error?.code === 'P2002') {
        this.metricsService.incrementCounter('users.find_or_create.race_p2002', 1);
        const existing = await this.findUserByAuthId(authId);
        if (existing) {
          const result: FindOrCreateUserResult = {
            user: existing,
            created: false,
            authId: existing.authId,
            userId: existing.id,
            network: existing.defaultNetwork ?? 'TESTNET',
          };
          await this.setIdempotencyCache(idempotencyKey, authId, result);
          return result;
        }
      }

      this.logger.error('User create failed', {
        authId: this.redactAuthId(authId),
        error: error?.message,
      });
      throw new ServiceUnavailableException({
        errorCode: IdempotentUserErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'User creation temporarily unavailable',
      });
    }
  }

  /**
   * Look up a previously stored idempotency result.
   *
   * Backed by the database so the result survives a process restart and is
   * visible to a second instance. If the key was previously used with a
   * different authId, this is a conflict.
   */
  private async getIdempotencyCache(
    idempotencyKey: string,
    authId: string,
  ): Promise<FindOrCreateUserResult | null> {
    try {
      const record = await this.prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });

      if (!record) {
        return null;
      }

      if (record.authId !== authId) {
        this.metricsService.incrementCounter(
          'users.find_or_create.idempotency_conflict',
          1,
        );
        this.logger.warn('Idempotency key reused with different authId', {
          idempotencyKey,
          authId: this.redactAuthId(authId),
        });
        throw new ConflictException({
          errorCode: IdempotentUserErrorCode.IDEMPOTENCY_CONFLICT,
          message: 'Idempotency key was already used for a different user',
        });
      }

      return record.result as unknown as FindOrCreateUserResult;
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      this.logger.error('Idempotency cache lookup failed', {
        idempotencyKey,
        error: error?.message,
      });
      throw new ServiceUnavailableException({
        errorCode: IdempotentUserErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Idempotency store temporarily unavailable',
      });
    }
  }

  /**
   * Persist a completed idempotency result durably.
   *
   * Uses an upsert keyed on the idempotency key so concurrent writers do not
   * fail; the first writer wins and later retries read the stored result.
   */
  private async setIdempotencyCache(
    idempotencyKey: string,
    authId: string,
    result: FindOrCreateUserResult,
  ): Promise<void> {
    try {
      await this.prisma.idempotencyKey.upsert({
        where: { key: idempotencyKey },
        create: {
          key: idempotencyKey,
          authId,
          result: result as unknown as Record<string, unknown>,
        },
        update: {},
      });
    } catch (error) {
      this.logger.error('Idempotency cache write failed', {
        idempotencyKey,
        authId: this.redactAuthId(authId),
        error: error?.message,
      });
      throw new ServiceUnavailableException({
        errorCode: IdempotentUserErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Idempotency store temporarily unavailable',
      });
    }
  }

  /**
   * Redact an authId for logging. Never log the raw auth id.
   */
  private redactAuthId(authId: string): string {
    if (!authId) {
      return 'unknown';
    }
    if (authId.length <= 8) {
      return `${authId.slice(0, 2)}***`;
    }
    return `${authId.slice(0, 4)}***${authId.slice(-4)}`;
  }

  /**
   * Deny-by-default authorization check.
   */
  private enforceAuthorization(actorContext: ActorContext): void {
    if (!actorContext || !actorContext.actorId) {
      throw new BadRequestException({
        errorCode: IdempotentUserErrorCode.NOT_AUTHORIZED,
        message: 'Actor context is required',
      });
    }
  }

  /**
   * Validate the authId input.
   */
  private validateAuthId(authId: string): void {
    if (!authId || typeof authId !== 'string' || authId.trim().length === 0) {
      throw new BadRequestException({
        errorCode: IdempotentUserErrorCode.INVALID_INPUT,
        message: 'authId is required',
      });
    }
  }
}
