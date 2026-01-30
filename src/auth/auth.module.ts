import { Module } from '@nestjs/common';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [UsersModule, WalletsModule],
  controllers: [AuthOrchestratorController],
  providers: [AuthOrchestrator],
  exports: [AuthOrchestrator],
})
export class AuthModule {}
