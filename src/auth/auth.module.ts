import { Module } from '@nestjs/common';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { IdempotencyService } from '../common/idempotency/idempotency.service';

@Module({
  imports: [UsersModule, WalletsModule],
  controllers: [AuthOrchestratorController],
  providers: [
    AuthOrchestrator,
    IdempotencyService,
    AuthRateLimitService,
    AuthRateLimitGuard,
  ],
  exports: [
    AuthOrchestrator,
    IdempotencyService,
    AuthRateLimitService,
    AuthRateLimitGuard,
  ],
})
export class AuthModule {}
