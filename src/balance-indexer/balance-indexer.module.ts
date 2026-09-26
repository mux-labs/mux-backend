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
import { ApiKeyModule } from '../api-keys/api-key.module';

/**
 * Horizon balance index and reconciliation.
 *
 * `HorizonRestBalanceClient` is the concrete `HorizonBalanceClient`
 * implementation. Tests override it with a fake so Horizon outages and
 * malformed payloads can be simulated deterministically without a live network.
 *
 * API-key auth comes from `ApiKeyModule` (single source of truth for key
 * validation/revocation and network scoping) rather than a locally declared
 * provider — a second instance would defeat immediate revocation (#942).
 */
@Module({
  imports: [ApiKeyModule],
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
  ],
  exports: [BalanceIndexerService],
})
export class BalanceIndexerModule {}
