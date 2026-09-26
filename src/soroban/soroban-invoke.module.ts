import { Module } from '@nestjs/common';
import { SorobanInvokeService } from './soroban-invoke.service';
import { SorobanInvokeController } from './soroban-invoke.controller';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';
import { ApiKeyAuditService } from '../api-keys/api-key-audit.service';

/**
 * Soroban invoke orchestration.
 *
 * `SOROBAN_RPC` and `CONTRACT_REGISTRY` are intentionally **not** bound here.
 * Both belong to the custody/network layer that owns the wallet keys and the
 * Soroban RPC endpoint. Until a deployment binds them, `SorobanInvokeService`
 * fails to construct and the surface is unreachable — fail-closed by absence,
 * rather than fail-open with a stub that would "succeed" without ever reaching
 * the chain. Do not add default implementations here.
 */
@Module({
  controllers: [SorobanInvokeController],
  providers: [
    SorobanInvokeService,
    MetricsService,
    ApiKeyGuard,
    ApiKeyService,
    // Audit sink for the guard: every API key decision on this surface is
    // recorded (fingerprint only, never key material).
    ApiKeyAuditService,
  ],
  exports: [SorobanInvokeService],
})
export class SorobanInvokeModule {}
