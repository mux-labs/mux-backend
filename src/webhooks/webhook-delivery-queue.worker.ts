import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Periodic worker that drains the webhook delivery queue.
 * Runs every WEBHOOK_QUEUE_INTERVAL_MS (default 30s).
 */
@Injectable()
export class WebhookDeliveryQueueWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryQueueWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private readonly intervalMs: number;

  constructor(
    private readonly dispatcher: WebhookDispatcherService,
    private readonly configService: ConfigService,
  ) {
    this.intervalMs = this.configService.get<number>(
      'WEBHOOK_QUEUE_INTERVAL_MS',
      30_000,
    );
  }

  onModuleInit() {
    this.timer = setInterval(() => this.run(), this.intervalMs);
    this.logger.log(`Delivery queue worker started (interval: ${this.intervalMs}ms)`);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log('Delivery queue worker stopped');
  }

  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn('Queue worker already running, skipping tick');
      return;
    }

    this.running = true;
    try {
      const result = await this.dispatcher.processDeliveries();
      if (result.delivered + result.failed + result.retrying > 0) {
        this.logger.log(
          `Queue tick: delivered=${result.delivered} failed=${result.failed} retrying=${result.retrying}`,
        );
      }
    } catch (err) {
      this.logger.error('Queue worker tick failed', err);
    } finally {
      this.running = false;
    }
  }
}
