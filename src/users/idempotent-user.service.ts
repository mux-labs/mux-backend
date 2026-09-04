import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserStatus } from './entities/user.entity';

export interface FindOrCreateUserRequest {
  authId: string;
  email?: string;
  displayName?: string;
  authProvider?: string;
  lastLoginIp?: string;
  lastLoginUserAgent?: string;
}

export interface User {
  id: string;
  authId: string;
  email?: string;
  displayName?: string;
  status?: UserStatus;
  authProvider: string;
  lastLoginAt?: Date;
  lastLoginIp?: string;
  lastLoginUserAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FindOrCreateUserResult {
  user: User;
  isNewUser: boolean;
}

export interface SessionListOptions {
  page?: number;
  limit?: number;
  status?: string;
  authProvider?: string;
  dateFrom?: Date;
  dateTo?: Date;
  userId?: string;
}

export interface SessionListResult {
  data: User[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class IdempotentUserService {
  private readonly logger = new Logger(IdempotentUserService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.logger.log('Idempotent User Service initialized');
  }

  /**
   * Finds an existing user by authId or creates a new one if not found.
   * This operation is idempotent - calling it multiple times with the same authId
   * will always return the same user without creating duplicates.
   */
  async findOrCreateUser(
    request: FindOrCreateUserRequest,
  ): Promise<FindOrCreateUserResult> {
    const {
      authId,
      email,
      displayName,
      authProvider = 'UNKNOWN',
      lastLoginIp,
      lastLoginUserAgent,
    } = request;

    this.logger.log(`Looking up user with authId: ${authId}`);

    // Validate and normalize the request the same way UsersService.create does,
    // so both paths agree on authId uniqueness (trimmed) and reject invalid input.
    this.validateRequest(request);

    const normalizedAuthId = authId.trim();
    const normalizedEmail = email?.trim() || null;
    const normalizedDisplayName = displayName?.trim() || null;

    try {
      const existingUser = await this.prisma.user.findUnique({
        where: { authId: normalizedAuthId },
      });

      if (existingUser) {
        this.validateUserState(existingUser);

        const updatedUser = await this.prisma.user.update({
          where: { id: existingUser.id },
          data: {
            lastLoginAt: new Date(),
            lastLoginIp,
            lastLoginUserAgent,
          },
        });

        this.logger.log(
          `Found existing user: ${existingUser.id}, updated last login`,
        );

        return {
          user: this.mapPrismaUserToDomain(updatedUser),
          isNewUser: false,
        };
      }

      const newUser = await this.prisma.user.create({
        data: {
          authId: normalizedAuthId,
          email: normalizedEmail,
          displayName: normalizedDisplayName,
          authProvider,
          lastLoginAt: new Date(),
          lastLoginIp,
          lastLoginUserAgent,
          status: UserStatus.ACTIVE,
        },
      });

      this.logger.log(`Created new user: ${newUser.id} with authId: ${authId}`);

      return {
        user: this.mapPrismaUserToDomain(newUser),
        isNewUser: true,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to find or create user with authId ${authId}:`,
        error,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      if (error?.code === 'P2002') {
        this.logger.log(
          `Race condition detected, retrying find for authId: ${authId}`,
        );

        const retryUser = await this.prisma.user.findUnique({
          where: { authId: normalizedAuthId },
        });

        if (retryUser) {
          const updatedRetryUser = await this.prisma.user.update({
            where: { id: retryUser.id },
            data: {
              lastLoginAt: new Date(),
              lastLoginIp,
              lastLoginUserAgent,
            },
          });

          return {
            user: this.mapPrismaUserToDomain(updatedRetryUser),
            isNewUser: false,
          };
        }
      }

      throw new Error(`User creation failed for authId: ${authId}`);
    }
  }

  /**
   * Lists authenticated sessions (users with lastLoginAt) with optional filters.
   * If userId is provided, scopes results to only that user's session (self-scoped).
   * Filters: status, authProvider, dateFrom/dateTo against lastLoginAt.
   * Results are ordered by lastLoginAt descending, with pagination.
   */
  async listSessions(options: SessionListOptions = {}): Promise<SessionListResult> {
    const { page = 1, status, authProvider, dateFrom, dateTo, userId } = options;
    const limit = Math.min(options.limit ?? 20, 100);

    const where: Record<string, any> = { deletedAt: null };
    if (userId) where.id = userId;
    if (status) where.status = status;
    if (authProvider) where.authProvider = authProvider;
    if (dateFrom || dateTo) {
      where.lastLoginAt = {};
      if (dateFrom) where.lastLoginAt.gte = dateFrom;
      if (dateTo) where.lastLoginAt.lte = dateTo;
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { lastLoginAt: 'desc' },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users.map((u) => this.mapPrismaUserToDomain(u)),
      total,
      page,
      limit,
    };
  }

  /**
   * Finds a user by authId without creating a new one
   */
  async findUserByAuthId(authId: string): Promise<User | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { authId },
      });

      return user ? this.mapPrismaUserToDomain(user) : null;
    } catch (error) {
      this.logger.error(`Failed to find user with authId ${authId}:`, error);
      throw new Error(`User lookup failed for authId: ${authId}`);
    }
  }

  /**
   * Finds a user by database ID
   */
  async findUserById(id: string): Promise<User | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id },
      });

      return user ? this.mapPrismaUserToDomain(user) : null;
    } catch (error) {
      this.logger.error(`Failed to find user with id ${id}:`, error);
      throw new Error(`User lookup failed for id: ${id}`);
    }
  }

  /**
   * Updates user information
   */
  async updateUser(
    id: string,
    updates: Partial<Omit<FindOrCreateUserRequest, 'authId'>>,
  ): Promise<User> {
    try {
      const updatedUser = await this.prisma.user.update({
        where: { id },
        data: updates,
      });

      this.logger.log(`Updated user: ${updatedUser.id}`);
      return this.mapPrismaUserToDomain(updatedUser);
    } catch (error) {
      this.logger.error(`Failed to update user with id ${id}:`, error);
      throw new Error(`User update failed for id: ${id}`);
    }
  }

  /**
   * Maps Prisma User to domain User model
   */
  private mapPrismaUserToDomain(prismaUser: any): User {
    return {
      id: prismaUser.id,
      authId: prismaUser.authId,
      email: prismaUser.email,
      displayName: prismaUser.displayName,
      status: prismaUser.status,
      authProvider: prismaUser.authProvider,
      lastLoginAt: prismaUser.lastLoginAt,
      lastLoginIp: prismaUser.lastLoginIp,
      lastLoginUserAgent: prismaUser.lastLoginUserAgent,
      createdAt: prismaUser.createdAt,
      updatedAt: prismaUser.updatedAt,
    };
  }

  /**
   * Validates authId format
   */
  private validateAuthId(authId: string): boolean {
    if (!authId || authId.trim().length === 0) {
      return false;
    }

    return authId.trim().length >= 3;
  }

  /**
   * Validates request data
   */
  private validateRequest(request: FindOrCreateUserRequest): void {
    if (!this.validateAuthId(request.authId)) {
      throw new ConflictException('Invalid authId provided');
    }

    if (request.email && !this.isValidEmail(request.email)) {
      throw new ConflictException('Invalid email format');
    }
  }

  /**
   * Basic email validation
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validates that a user is in a valid state for authentication
   * Throws error if user is in an invalid/stale state (e.g., SUSPENDED, DISABLED)
   */
  private validateUserState(user: any): void {
    const status = (user.status || UserStatus.ACTIVE) as UserStatus;

    if (status !== UserStatus.ACTIVE) {
      this.logger.error(
        `User ${user.id} with authId ${user.authId} is in invalid state: ${status}`,
      );
      throw new BadRequestException(
        `User account is in an invalid state (${status}). Please contact support.`,
      );
    }
  }
}
