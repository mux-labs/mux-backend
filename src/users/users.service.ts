import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createUserDto: CreateUserDto) {
    const { authId, email, displayName, authProvider } = createUserDto;

    const trimmedAuthId = authId?.trim();
    if (!trimmedAuthId) {
      throw new BadRequestException('authId is required');
    }

    return this.prisma.user.create({
      data: {
        authId: trimmedAuthId,
        email,
        displayName,
        authProvider: authProvider?.trim() || 'UNKNOWN',
        status: 'ACTIVE',
        lastLoginAt: new Date(),
      },
    });
  }

  async findAll() {
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
      },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    const data: Record<string, unknown> = {};

    if (updateUserDto.email !== undefined) {
      data.email = updateUserDto.email;
    }
    if (updateUserDto.displayName !== undefined) {
      data.displayName = updateUserDto.displayName;
    }
    if (updateUserDto.authProvider !== undefined) {
      data.authProvider = updateUserDto.authProvider;
    }
    if (updateUserDto.status !== undefined) {
      data.status = updateUserDto.status;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No update fields provided');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser || existingUser.deletedAt) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async remove(id: string) {
    const existingUser = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser || existingUser.deletedAt) {
      throw new NotFoundException(`User with id ${id} not found`);
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'DELETED',
      },
    });
  }
}
