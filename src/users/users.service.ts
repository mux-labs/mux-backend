import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(createUserDto: CreateUserDto) {
    this.logger.log(`Creating user with email: ${createUserDto.email}`);
    
    try {
      const user = await this.prisma.user.create({
        data: {
          email: createUserDto.email,
        },
      });

      this.logger.log(`Successfully created user with ID: ${user.id}`);
      return user;
    } catch (error) {
      this.logger.error(`Failed to create user with email: ${createUserDto.email}`, error);
      throw error;
    }
  }

  async findAll() {
    return await this.prisma.user.findMany({
      include: { wallet: true },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { wallet: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return user;
  }

  async findByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { wallet: true },
    });

    if (!user) {
      throw new NotFoundException(`User with email ${email} not found`);
    }

    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    this.logger.log(`Updating user with ID: ${id}`);
    
    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: updateUserDto,
        include: { wallet: true },
      });

      this.logger.log(`Successfully updated user with ID: ${user.id}`);
      return user;
    } catch (error) {
      this.logger.error(`Failed to update user with ID: ${id}`, error);
      throw error;
    }
  }

  async remove(id: string) {
    this.logger.log(`Removing user with ID: ${id}`);
    
    try {
      await this.prisma.user.delete({
        where: { id },
      });

      this.logger.log(`Successfully removed user with ID: ${id}`);
      return { message: `User with ID ${id} has been removed` };
    } catch (error) {
      this.logger.error(`Failed to remove user with ID: ${id}`, error);
      throw error;
    }
  }
}
