import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient({} as any);
  }

  async create(createUserDto: CreateUserDto) {
    const { authId, email, displayName, authProvider = 'UNKNOWN' } =
      createUserDto;

    if (!authId || authId.trim().length < 3) {
      throw new ConflictException(
        'authId is required and must be at least 3 characters',
      );
    }

    try {
      const user = await this.prisma.user.create({
        data: {
          authId: authId.trim(),
          email: email?.trim() || null,
          displayName: displayName?.trim() || null,
          authProvider,
          status: 'ACTIVE',
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

  async findAll() {
    return this.prisma.user.findMany({ where: { deletedAt: null } });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return this.mapPrismaUser(user);
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    try {
      const updatedUser = await this.prisma.user.update({
        where: { id },
        data: {
          authId: updateUserDto.authId?.trim(),
          email: updateUserDto.email?.trim(),
          displayName: updateUserDto.displayName?.trim(),
          authProvider: updateUserDto.authProvider,
          updatedAt: new Date(),
        },
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
    try {
      return this.prisma.user.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(`Failed to remove user ${id}:`, error);
      throw new NotFoundException(`User with ID ${id} not found`);
    }
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
