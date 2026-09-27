import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertUserCanTransact,
  userNotFound,
  UserOperation,
  UserStatusErrorCode,
  UserStatusSubject,
} from './user-status.policy';

/**
 * Injection token for the user-status port.
 *
 * Money-path services depend on this interface, not on a concrete store, so
 * they can be unit-tested with a deterministic stub and so the enforcement
 * point is visible in the constructor signature.
 */
export const USER_STATUS_PORT = Symbol('USER_STATUS_PORT');

export interface UserStatusPort {
  /**
   * Resolves the account and throws unless it may perform `operation`.
   *
   * @throws ForbiddenException when the account is suspended/disabled.
   * @throws NotFoundException when the account does not exist.
   * @throws ServiceUnavailableException when the status cannot be read.
   */
  assertCanTransact(
    userId: string,
    operation: UserOperation,
    correlationId?: string,
  ): Promise<void>;
}

/** Minimal structural view of the Prisma `User` delegate. */
interface UserStatusStore {
  user: {
    findUnique(args: {
      where: { id?: string; authId?: string };
      select?: unknown;
    }): Promise<{ id: string; status: string } | null>;
  };
}

/**
 * Enforces the `UserStatus` policy (#941) against the authoritative user row.
 *
 * Fail-closed: a store outage is a 503, never an allow. The one documented
 * exception is the `test`/`development` environments, where the store may be
 * absent entirely (the e2e suites run without a database) — in that case the
 * check is a no-op *with a warning*, and it is impossible to enable in any
 * other environment because the constructor treats `production` and `staging`
 * as strict.
 *
 * Never logs or returns anything from the user row except its id and status.
 */
@Injectable()
export class UserStatusService implements UserStatusPort {
  private readonly logger = new Logger(UserStatusService.name);

  private store: UserStatusStore | null = null;
  private storeResolved = false;

  /**
   * Whether an unverifiable status is tolerated. Only ever true in
   * `test`/`development`, where the documented e2e suites run without a DB.
   */
  private readonly allowWhenUnverifiable: boolean;

  constructor(
    @Optional() @Inject(ConfigService) configService?: ConfigService,
  ) {
    const nodeEnv = (
      configService?.get<string>('NODE_ENV') ??
      process.env.NODE_ENV ??
      ''
    )
      .trim()
      .toLowerCase();

    this.allowWhenUnverifiable =
      nodeEnv !== 'production' &&
      (nodeEnv === 'test' || nodeEnv === 'development');
  }

  async assertCanTransact(
    userId: string,
    operation: UserOperation,
    correlationId?: string,
  ): Promise<void> {
    if (!userId || typeof userId !== 'string') {
      throw userNotFound(String(userId), correlationId);
    }

    const store = this.resolveStore();

    if (!store) {
      this.handleUnverifiable(userId, operation, correlationId, 'no store');
      return;
    }

    let subject: UserStatusSubject;

    try {
      const user = await store.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw userNotFound(userId, correlationId);
      }
      subject = { userId: user.id, status: user.status };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.handleUnverifiable(
        userId,
        operation,
        correlationId,
        (error as Error)?.message ?? 'store error',
      );
      return;
    }

    assertUserCanTransact(subject, operation, correlationId);
  }

  /**
   * Handles "we could not verify the status".
   *
   * Strict environments fail closed with 503. Only `test`/`development` may
   * proceed, and even then the decision is logged so it is never silent.
   */
  private handleUnverifiable(
    userId: string,
    operation: UserOperation,
    correlationId: string | undefined,
    detail: string,
  ): void {
    if (this.allowWhenUnverifiable) {
      this.logger.warn(
        `user-status unverifiable event=user_status_unverified operation=${operation} ` +
          `userId=${userId} correlationId=${correlationId ?? 'none'} detail=${detail}`,
      );
      return;
    }

    this.logger.error(
      `user-status unverifiable event=user_status_unavailable operation=${operation} ` +
        `userId=${userId} correlationId=${correlationId ?? 'none'} detail=${detail}`,
    );
    throw new ServiceUnavailableException({
      code: UserStatusErrorCode.USER_STATUS_UNAVAILABLE,
      message: 'User status could not be verified',
      correlationId,
    });
  }

  /**
   * Lazily constructs the Prisma-backed store.
   *
   * Deliberately lazy: importing this service must not open a database
   * connection at boot, so a module that merely *wires* the port (without any
   * money-path call) is unaffected in tests and health checks.
   */
  private resolveStore(): UserStatusStore | null {
    if (this.storeResolved) {
      return this.store;
    }
    this.storeResolved = true;

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PrismaClient } = require('../generated/prisma/client') as {
        PrismaClient: new (options: Record<string, unknown>) => UserStatusStore;
      };
      this.store = new PrismaClient({});
    } catch {
      this.store = null;
    }

    return this.store;
  }
}
