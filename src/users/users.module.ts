import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { IdempotentUserService } from './idempotent-user.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, IdempotentUserService],
  exports: [UsersService, IdempotentUserService],
})
export class UsersModule {}
