import { Module } from '@nestjs/common';
import { SorobanInvokeService } from './soroban-invoke.service';
import { SorobanInvokeController } from './soroban-invoke.controller';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyModule } from '../api-keys/api-key.module';

/**
 * Soroban invoke orchestration.
 *
 * `SOROBAN_RPC` and `CONTRACT_REGISTRY` are intentionally **not** bound here.
 * Both belong to the custody/network layer that owns the wallet keys and the
 * Soroban RPC endpoint. Until a deployment binds them, `SorobanInvokeService`
 * fails to construct and the surface is unreachable — fail-closed by absence,
 * rather than fail-open with a stub that would "succeed" without ever reaching
 * the chain. Do not add default implementations here.
 *
 * API-key auth is provided by `ApiKeyModule` (one instance platform-wide, so
 * revocation is immediate — #942).
 */
@Module({
  imports: [ApiKeyModule],
  controllers: [SorobanInvokeController],
  providers: [SorobanInvokeService, MetricsService],
  exports: [SorobanInvokeService],
})
export class SorobanInvokeModule {}
