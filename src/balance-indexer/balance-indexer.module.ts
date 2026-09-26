import { Module } from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import { BalanceIndexerController } from './balance-indexer.controller';
import { HorizonRestBalanceClient } from './horizon-rest-balance.client';
import {
  BALANCE_STORE,
  HORIZON_BALANCE_CLIENT,
} from './balance-indexer.error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyService } from '../api-keys/api-key.service';

/**
 * Horizon balance index and reconciliation.
 *
 * `HorizonRestBalanceClient` is the concrete `HorizonBalanceClient`
 * implementation. Tests override it with a fake so Horizon outages and
 * malformed payloads can be simulated deterministically without a live network.
 */
@Module({
  controllers: [BalanceIndexerController],
  providers: [
    PrismaService,
    MetricsService,
    BalanceIndexerService,
    // Bound to port tokens so the service depends on the interfaces, not on
    // the concrete implementations. Tests rebind BALANCE_STORE /
    // HORIZON_BALANCE_CLIENT to fakes without touching the service.
    // PrismaService satisfies BalanceStore structurally.
    { provide: BALANCE_STORE, useExisting: PrismaService },
    { provide: HORIZON_BALANCE_CLIENT, useClass: HorizonRestBalanceClient },
    ApiKeyGuard,
    ApiKeyService,
  ],
  exports: [BalanceIndexerService],
})
export class BalanceIndexerModule {}
