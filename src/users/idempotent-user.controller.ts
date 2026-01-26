import { Controller, Post, Get, Put, Body, Param, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { IdempotentUserService, type FindOrCreateUserRequest, type FindOrCreateUserResult } from './idempotent-user.service';

@Controller('users/idempotent')
export class IdempotentUserController {
  constructor(private readonly idempotentUserService: IdempotentUserService) {}

  @Post('find-or-create')
  @HttpCode(HttpStatus.OK)
  async findOrCreateUser(@Body() request: FindOrCreateUserRequest): Promise<FindOrCreateUserResult> {
    try {
      return await this.idempotentUserService.findOrCreateUser(request);
    } catch (error) {
      throw new Error(`Failed to find or create user: ${error.message}`);
    }
  }

  @Get('auth/:authId')
  async findUserByAuthId(@Param('authId') authId: string) {
    const user = await this.idempotentUserService.findUserByAuthId(authId);
    
    if (!user) {
      throw new NotFoundException(`User with authId ${authId} not found`);
    }
    
    return user;
  }

  @Get(':id')
  async findUserById(@Param('id') id: string) {
    const user = await this.idempotentUserService.findUserById(id);
    
    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }
    
    return user;
  }

  @Put(':id')
  async updateUser(
    @Param('id') id: string,
    @Body() updates: Partial<Omit<FindOrCreateUserRequest, 'authId'>>
  ) {
    try {
      return await this.idempotentUserService.updateUser(id, updates);
    } catch (error) {
      throw new Error(`Failed to update user: ${error.message}`);
    }
  }
}
