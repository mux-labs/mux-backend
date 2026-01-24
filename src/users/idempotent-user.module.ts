import { Module } from '@nestjs/common';
import { IdempotentUserService } from './idempotent-user.service';
import { IdempotentUserController } from './idempotent-user.controller';

@Module({
  controllers: [IdempotentUserController],
  providers: [IdempotentUserService],
  exports: [IdempotentUserService],
})
export class IdempotentUserModule {}
