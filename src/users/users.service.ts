import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserStatus } from './entities/user.entity';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { ApiKeyStatus } from '../api-keys/domain/api-key.model';
import { RequestContextService } from '../common/request-context/request-context.service';
import { MetricsService } from '../common/metrics/metrics.service';

export interface UserListOptions {
  page?: number;
  limit?: number;
  status?: UserStatus;
}

/**
 * Wallet states that are already terminal/blocked. They must not be re-written
 * during user deletion — DISABLED, COMPROMISED, and ARCHIVED wallets are all
 * permanently unusable, so leaving them untouched is safe and audit-friendly.
 */
const TERMINAL_WALLET_STATUSES = [
  WalletStatus.DISABLED,
  WalletStatus.COMPROMISED,
  WalletStatus.ARCHIVED,
];

/** Webhook endpoint status that stops dispatch (see webhook-dispatcher.service). */
const WEBHOOK_DISABLED_STATUS = 'DISABLED';

/** Reason recorded on resources cleaned up because their owner was deleted. */
const OWNER_DELETED_REASON = 'Owner user deleted';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private prisma: PrismaClient;

  constructor(
    @Optional() prisma?: PrismaClient,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.prisma = prisma ?? new PrismaClient({} as any);
  }

  async create(createUserDto: CreateUserDto) {
    const {
      authId,
      email,
      displayName,
      authProvider = 'UNKNOWN',
      status,
    } = createUserDto;

    if (!authId || authId.trim().length < 3) {
      throw new ConflictException(
        'authId is required and must be at least 3 characters',
      );
    }

    const selectedStatus = status
      ? this.normalizeStatus(status)
      : UserStatus.ACTIVE;

    try {
      const user = await this.prisma.user.create({
        data: {
          authId: authId.trim(),
          email: email?.trim() || null,
          displayName: displayName?.trim() || null,
          authProvider,
          status: selectedStatus,
        },
      });

      this.logger.log(`Created new user ${user.id}`);
      return this.mapPrismaUser(user);
    } catch (error: any) {
      this.logger.error('Failed to create user:', error);
      if (error?.code === 'P2002') {
        throw new ConflictException('User authId already exists');
      }
      throw new Error('User creation failed');
    }
  }

  async findAll(options?: UserListOptions) {
    const where: any = { deletedAt: null };

    if (options?.status) {
      where.status = options.status;
    }

    const query: any = {
      where,
      orderBy: { createdAt: 'desc' as const },
    };

    if (options?.limit || options?.page) {
      query.take = options?.limit ?? 50;
      if (options?.page && options.page > 0) {
        query.skip = (options.page - 1) * query.take;
      }
    }

    return this.prisma.user.findMany(query);
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (user && !user.deletedAt) {
      return this.mapPrismaUser(user);
    }

    if (user && user.deletedAt) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const legacyId = Number(id);
    if (!Number.isNaN(legacyId) && legacyId.toString() === id) {
      const legacyUser = await this.prisma.legacyUser.findUnique({
        where: { id: legacyId },
      });

      if (legacyUser) {
        return this.mapLegacyUser(legacyUser);
      }
    }

    throw new NotFoundException(`User with ID ${id} not found`);
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    const data: any = {};

    if (updateUserDto.email) {
      data.email = updateUserDto.email.trim();
    }

    if (updateUserDto.displayName) {
      data.displayName = updateUserDto.displayName.trim();
    }

    if (updateUserDto.authProvider) {
      data.authProvider = updateUserDto.authProvider;
    }

    if (updateUserDto.status) {
      data.status = this.normalizeStatus(updateUserDto.status);
    }

    try {
      const updatedUser = await this.prisma.user.update({
        where: { id },
        data,
      });

      return this.mapPrismaUser(updatedUser);
    } catch (error: any) {
      this.logger.error(`Failed to update user ${id}:`, error);
      if (error?.code === 'P2002') {
        throw new ConflictException('User authId already exists');
      }
      throw new NotFoundException(`User with ID ${id} not found`);
    }
  }

  /**
   * Deletes a user and cleans up every resource that user owns, atomically.
   *
   * A deleted user must not leave anything behind that can still be used:
   *  1. custody wallets are transitioned to DISABLED (terminal — keys can no
   *     longer sign or be rotated), so no orphaned Stellar key material stays
   *     live in the custody layer;
   *  2. developers owned by the user (and their projects) are soft-deleted;
   *  3. API keys under those projects are REVOKED so they can no longer
   *     authenticate to the /v1 API;
   *  4. webhook endpoints are disabled so no deliveries keep firing.
   *
   * Everything runs inside a single Prisma transaction: if any step fails the
   * whole deletion rolls back and the user stays active (fail-closed — there
   * is no partial cleanup and no silent no-op path, regardless of NODE_ENV).
   */
  async remove(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    if (user.deletedAt) {
      throw new ConflictException(`User with ID ${id} is already deleted`);
    }

    if (user.status === UserStatus.DISABLED) {
      throw new ConflictException(
        'Disabled users cannot be deleted. Change status before deletion.',
      );
    }

    const reqId = RequestContextService.getCurrentRequestId() ?? 'n/a';
    const startedAt = Date.now();

    try {
      const deletedUser = await this.prisma.$transaction(async (tx) => {
        const now = new Date();

        // 1. Disable custody wallets so their encrypted keys can never sign again.
        const walletResult = await tx.wallet.updateMany({
          where: {
            userId: id,
            status: { notIn: TERMINAL_WALLET_STATUSES },
          },
          data: {
            status: WalletStatus.DISABLED,
            statusReason: OWNER_DELETED_REASON,
            statusChangedAt: now,
          },
        });

        // 2. Find the developers owned by this user.
        const ownedDevelopers = await tx.developer.findMany({
          where: { userId: id, deletedAt: null },
          select: { id: true },
        });
        const developerIds = ownedDevelopers.map((d) => d.id);

        let projectsDeleted = 0;
        let apiKeysRevoked = 0;
        let webhooksDisabled = 0;

        if (developerIds.length > 0) {
          // 3. Collect the projects owned by those developers.
          const ownedProjects = await tx.project.findMany({
            where: { developerId: { in: developerIds }, deletedAt: null },
            select: { id: true },
          });
          const projectIds = ownedProjects.map((p) => p.id);

          if (projectIds.length > 0) {
            // 4. Revoke every API key under those projects so none of them can
            //    authenticate to the /v1 API anymore.
            const revoked = await tx.apiKey.updateMany({
              where: {
                projectId: { in: projectIds },
                status: { not: ApiKeyStatus.REVOKED },
              },
              data: {
                status: ApiKeyStatus.REVOKED,
                revokedAt: now,
                revokedReason: OWNER_DELETED_REASON,
              },
            });
            apiKeysRevoked = revoked.count;

            // 5. Disable webhook endpoints so no further deliveries fire.
            const disabled = await tx.webhookEndpoint.updateMany({
              where: {
                projectId: { in: projectIds },
                status: { not: WEBHOOK_DISABLED_STATUS },
              },
              data: {
                status: WEBHOOK_DISABLED_STATUS,
                deletedAt: now,
              },
            });
            webhooksDisabled = disabled.count;

            // 6. Soft-delete the projects.
            const projects = await tx.project.updateMany({
              where: { id: { in: projectIds } },
              data: { deletedAt: now },
            });
            projectsDeleted = projects.count;
          }

          // 7. Soft-delete the developers owned by this user.
          await tx.developer.updateMany({
            where: { id: { in: developerIds } },
            data: { deletedAt: now },
          });
        }

        // 8. Soft-delete the user last — if anything above fails, the whole
        //    transaction rolls back and the user remains active.
        const updated = await tx.user.update({
          where: { id },
          data: { deletedAt: now },
        });

        this.logger.log(
          `[reqId=${reqId}] Deleted user ${id}: disabled ${walletResult.count} wallet(s), ` +
            `soft-deleted ${developerIds.length} developer(s) and ${projectsDeleted} project(s), ` +
            `revoked ${apiKeysRevoked} API key(s), disabled ${webhooksDisabled} webhook endpoint(s)`, // eslint-disable-line max-len
        );

        return updated;
      });

      this.metrics?.incrementCounter('users_deleted_total', {
        outcome: 'success',
      });
      this.metrics?.recordHistogram?.(
        'users_deletion_duration_seconds',
        (Date.now() - startedAt) / 1000,
      );

      return deletedUser;
    } catch (error: any) {
      this.metrics?.incrementCounter('users_deleted_total', {
        outcome: 'failure',
      });
      this.logger.error(
        `[reqId=${reqId}] Failed to delete user ${id} — deletion rolled back:`,
        error,
      );
      throw error;
    }
  }

  private normalizeStatus(status: string): UserStatus {
    if (!Object.values(UserStatus).includes(status as UserStatus)) {
      throw new BadRequestException(`Invalid user status: ${status}.`);
    }

    return status as UserStatus;
  }

  private mapLegacyUser(legacyUser: any) {
    return {
      id: legacyUser.id.toString(),
      authId: legacyUser.email,
      email: legacyUser.email,
      displayName: legacyUser.name ?? null,
      status: UserStatus.ACTIVE,
      authProvider: 'LEGACY',
      lastLoginAt: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  private mapPrismaUser(prismaUser: any) {
    return {
      id: prismaUser.id,
      authId: prismaUser.authId,
      email: prismaUser.email,
      displayName: prismaUser.displayName,
      status: prismaUser.status,
      authProvider: prismaUser.authProvider,
      lastLoginAt: prismaUser.lastLoginAt,
      createdAt: prismaUser.createdAt,
      updatedAt: prismaUser.updatedAt,
    };
  }
}
