import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';

/**
 * Periodic scheduler that cleans up stale PROVISIONING wallets left behind by
 * crashed orchestration runs by calling
 * `cleanupStaleProvisioningWallets()` on a configurable interval.
 *
 * Configuration (environment variables):
 *   STALE_PROVISIONING_CLEANUP_INTERVAL_MS – interval in ms (default: 300_000 = 5 minutes)
 */
@Injectable()
export class WalletCleanupSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WalletCleanupSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  private readonly intervalMs: number;

  constructor(
    private readonly orchestrator: WalletCreationOrchestrator,
    private readonly configService: ConfigService,
  ) {
    this.intervalMs = this.configService.get<number>(
      'STALE_PROVISIONING_CLEANUP_INTERVAL_MS',
      5 * 60 * 1000,
    );
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      this.orchestrator.cleanupStaleProvisioningWallets().catch((err) => {
        this.logger.error(
          'Scheduled stale PROVISIONING wallet cleanup failed',
          err,
        );
      });
    }, this.intervalMs);
    this.logger.log(
      `Stale PROVISIONING wallet cleanup scheduler started (interval: ${this.intervalMs}ms)`,
    );
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log('Stale PROVISIONING wallet cleanup scheduler stopped');
  }
}
