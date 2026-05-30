import { Module } from '@nestjs/common';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { IdempotencyService } from '../common/idempotency/idempotency.service';

@Module({
  imports: [UsersModule, WalletsModule],
  controllers: [AuthOrchestratorController],
  providers: [AuthOrchestrator, IdempotencyService],
  exports: [AuthOrchestrator, IdempotencyService],
})
export class AuthModule {}
