import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserStatus } from './entities/user.entity';

export interface UserListOptions {
  page?: number;
  limit?: number;
  status?: UserStatus;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
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

    if (updateUserDto.authId) {
      data.authId = updateUserDto.authId.trim();
    }

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

    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private normalizeStatus(status: string): UserStatus {
    if (!Object.values(UserStatus).includes(status as UserStatus)) {
      throw new BadRequestException(
        `Invalid user status: ${status}.`,
      );
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
