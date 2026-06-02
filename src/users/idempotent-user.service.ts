import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserStatus } from './entities/user.entity';

export interface FindOrCreateUserRequest {
  authId: string;
  email?: string;
  displayName?: string;
  authProvider?: string;
}

export interface User {
  id: string;
  authId: string;
  email?: string;
  displayName?: string;
  status?: UserStatus;
  authProvider: string;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FindOrCreateUserResult {
  user: User;
  isNewUser: boolean;
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
    const { authId, email, displayName, authProvider = 'UNKNOWN' } = request;

    this.logger.log(`Looking up user with authId: ${authId}`);

    try {
      const existingUser = await this.prisma.user.findUnique({
        where: { authId },
      });

      if (existingUser) {
        this.validateUserState(existingUser);

        const updatedUser = await this.prisma.user.update({
          where: { id: existingUser.id },
          data: { lastLoginAt: new Date() },
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
          authId,
          email,
          displayName,
          authProvider,
          lastLoginAt: new Date(),
          status: 'ACTIVE',
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

      if (error?.code === 'P2002') {
        this.logger.log(
          `Race condition detected, retrying find for authId: ${authId}`,
        );

        const retryUser = await this.prisma.user.findUnique({
          where: { authId },
        });

        if (retryUser) {
          const updatedRetryUser = await this.prisma.user.update({
            where: { id: retryUser.id },
            data: { lastLoginAt: new Date() },
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
