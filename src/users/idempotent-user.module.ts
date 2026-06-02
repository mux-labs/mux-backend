import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { IdempotentUserService } from './idempotent-user.service';
import { IdempotentUserController } from './idempotent-user.controller';

@Module({
  imports: [PrismaModule],
  controllers: [IdempotentUserController],
  providers: [IdempotentUserService],
  exports: [IdempotentUserService],
})
export class IdempotentUserModule {}
