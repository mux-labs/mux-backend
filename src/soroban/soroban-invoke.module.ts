import { Module } from '@nestjs/common';
import { SorobanInvokeService } from './soroban-invoke.service';
import { SorobanContractBootValidatorService } from './soroban-contract-boot-validator.service';
import { SorobanInvokeController } from './soroban-invoke.controller';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';

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
    // #954: fail-closed boot gate. Runs onModuleInit before the surface can
    // serve traffic, so a bad contract id is a startup failure rather than a
    // confusing RPC error on the first live invoke.
    SorobanContractBootValidatorService,
    MetricsService,
    ApiKeyGuard,
    ApiKeyService,
  ],
  exports: [SorobanInvokeService],
})
export class SorobanInvokeModule {}

