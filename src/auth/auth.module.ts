import { Module } from '@nestjs/common';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthMetricsService } from './auth-metrics.service';
import { AuthMetricsController } from './auth-metrics.controller';
import { RefreshTokenService } from './refresh-token.service';
import { JwtVerificationService } from './jwt-verification.service';
import { IdempotentUserModule } from '../users/idempotent-user.module';
import { WalletsModule } from '../wallets/wallets.module';
import { PrismaModule } from '../prisma/prisma.module';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { WebhookModule } from '../webhooks/webhook.module';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

@Module({
  imports: [IdempotentUserModule, WalletsModule],
  controllers: [AuthOrchestratorController, AuthMetricsController],
  providers: [
    AuthOrchestrator,
    RefreshTokenService,
    JwtVerificationService,
    IdempotencyService,
    AuthRateLimitService,
    AuthRateLimitGuard,
    FeatureFlagService,
    FeatureFlagGuard,
    AuthMetricsService,
  ],
  exports: [
    AuthOrchestrator,
    RefreshTokenService,
    JwtVerificationService,
    IdempotencyService,
    AuthRateLimitService,
    AuthRateLimitGuard,
    FeatureFlagService,
    FeatureFlagGuard,
    AuthMetricsService,
  ],
})
export class AuthModule {}
