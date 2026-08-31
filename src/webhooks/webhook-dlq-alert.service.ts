import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { DeliveryStatus } from './domain/webhook-events';
import axios from 'axios';

export interface DlqAlertThresholds {
  /** Absolute number of dead-lettered deliveries that triggers an alert */
  absoluteThreshold: number;
  /** Percentage of total deliveries in DLQ state that triggers an alert */
  percentageThreshold: number;
  /** Age in milliseconds — alert when oldest DLQ item is older than this */
  ageThresholdMs: number;
}

export interface DlqStatus {
  dlqDepth: number;
  totalDeliveries: number;
  dlqPercentage: number;
  oldestDlqItemAgeMs: number | null;
  thresholdBreached: boolean;
  alerts: DlqAlert[];
  checkedAt: Date;
}

export interface DlqAlert {
  type: 'ABSOLUTE_THRESHOLD' | 'PERCENTAGE_THRESHOLD' | 'AGE_THRESHOLD';
  message: string;
  value: number;
  threshold: number;
}

/**
 * WebhookDlqAlertService
 *
 * Monitors the webhook Dead Letter Queue depth and fires alerts when
 * configurable thresholds are breached. Runs on a polling interval
 * and emits Prometheus metrics so the team can set up dashboard alerts.
 *
 * In addition to metrics, it can POST a structured JSON payload to an ops
 * webhook URL (e.g. Slack incoming webhook, PagerDuty events API, or any
 * HTTP endpoint) when a threshold is violated.
 *
 * Configuration (environment variables):
 *   DLQ_CHECK_INTERVAL_MS        – polling interval in ms (default: 60_000)
 *   DLQ_ABSOLUTE_THRESHOLD       – alert when DLQ depth ≥ this value (default: 50)
 *   DLQ_PERCENTAGE_THRESHOLD     – alert when DLQ% of total deliveries ≥ this value (default: 10)
 *   DLQ_AGE_THRESHOLD_MS         – alert when oldest DLQ item is older than this in ms (default: 3_600_000 = 1h)
 *
 * Ops/pager notification (optional):
 *   DLQ_OPS_WEBHOOK_URL          – HTTP(S) URL to POST alert payloads to when thresholds breach
 *                                   Leave unset to disable outbound notifications (metrics-only mode).
 *   DLQ_OPS_WEBHOOK_TIMEOUT_MS   – timeout for the outbound call in ms (default: 5_000)
 *
 * The ops webhook receives a JSON body with the shape:
 *   {
 *     "service": "mux-backend",
 *     "event": "dlq.threshold_breached",
 *     "dlqDepth": <number>,
 *     "totalDeliveries": <number>,
 *     "dlqPercentage": <number>,
 *     "oldestDlqItemAgeMs": <number|null>,
 *     "alerts": [ { "type": "...", "message": "...", "value": ..., "threshold": ... } ],
 *     "checkedAt": "<ISO8601>"
 *   }
 *
 * Notification failures are logged as warnings but never cause the check
 * itself to fail — monitoring must not take down the worker.
 */
@Injectable()
export class WebhookDlqAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDlqAlertService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly thresholds: DlqAlertThresholds;
  private readonly opsWebhookUrl: string | undefined;
  private readonly opsWebhookTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.intervalMs = this.configService.get<number>(
      'DLQ_CHECK_INTERVAL_MS',
      60_000,
    );
    this.thresholds = {
      absoluteThreshold: this.configService.get<number>(
        'DLQ_ABSOLUTE_THRESHOLD',
        50,
      ),
      percentageThreshold: this.configService.get<number>(
        'DLQ_PERCENTAGE_THRESHOLD',
        10,
      ),
      ageThresholdMs: this.configService.get<number>(
        'DLQ_AGE_THRESHOLD_MS',
        3_600_000,
      ),
    };

    // Ops/pager hook — optional.
    const rawOpsUrl = this.configService
      .get<string>('DLQ_OPS_WEBHOOK_URL', '')
      ?.trim();
    this.opsWebhookUrl = rawOpsUrl || undefined;
    this.opsWebhookTimeoutMs = this.configService.get<number>(
      'DLQ_OPS_WEBHOOK_TIMEOUT_MS',
      5_000,
    );

    if (this.opsWebhookUrl) {
      this.logger.log(
        `DLQ ops notifications enabled → ${this.opsWebhookUrl} ` +
          `(timeout: ${this.opsWebhookTimeoutMs}ms)`,
      );
    }
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      this.checkDlqDepth().catch((err) => {
        this.logger.error('DLQ alert check failed', err);
      });
    }, this.intervalMs);

    this.logger.log(
      `DLQ alert monitor started (interval: ${this.intervalMs}ms, ` +
        `absoluteThreshold: ${this.thresholds.absoluteThreshold}, ` +
        `percentageThreshold: ${this.thresholds.percentageThreshold}%)`,
    );
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.log('DLQ alert monitor stopped');
  }

  /**
   * Checks the DLQ depth and evaluates alert thresholds.
   * Emits Prometheus metrics regardless of threshold breach.
   * Logs a warning for every threshold that is violated.
   * POSTs to DLQ_OPS_WEBHOOK_URL when any threshold is breached (if configured).
   */
  async checkDlqDepth(): Promise<DlqStatus> {
    const now = new Date();

    const [dlqCount, totalCount, oldestDlqItem] = await Promise.all([
      this.prisma.webhookDelivery.count({
        where: { status: DeliveryStatus.FAILED },
      }),
      this.prisma.webhookDelivery.count(),
      this.prisma.webhookDelivery.findFirst({
        where: { status: DeliveryStatus.FAILED },
        orderBy: { lastAttemptAt: 'asc' },
        select: { lastAttemptAt: true, createdAt: true },
      }),
    ]);

    const dlqPercentage =
      totalCount > 0 ? (dlqCount / totalCount) * 100 : 0;
    const oldestItemTimestamp =
      oldestDlqItem?.lastAttemptAt ?? oldestDlqItem?.createdAt ?? null;
    const oldestAgeMs = oldestItemTimestamp
      ? now.getTime() - oldestItemTimestamp.getTime()
      : null;

    // Emit Prometheus metrics
    this.recordMetrics(dlqCount, totalCount, dlqPercentage, oldestAgeMs);

    // Evaluate thresholds and build alert list
    const alerts = this.evaluateThresholds(
      dlqCount,
      dlqPercentage,
      oldestAgeMs,
    );
    const thresholdBreached = alerts.length > 0;

    if (thresholdBreached) {
      for (const alert of alerts) {
        this.logger.warn(`[DLQ ALERT] ${alert.message}`, {
          type: alert.type,
          value: alert.value,
          threshold: alert.threshold,
          dlqDepth: dlqCount,
          totalDeliveries: totalCount,
          dlqPercentage: dlqPercentage.toFixed(2),
        });
      }

      this.metrics.incrementCounter('webhook_dlq_alert_fired_total', {
        reason: alerts.map((a) => a.type).join(','),
      });

      // Fire the ops/pager notification (non-blocking, non-fatal)
      this.notifyOps({
        dlqDepth: dlqCount,
        totalDeliveries: totalCount,
        dlqPercentage,
        oldestDlqItemAgeMs: oldestAgeMs,
        alerts,
        checkedAt: now,
      }).catch((err) => {
        this.logger.warn(
          `DLQ ops notification failed (non-fatal): ${err?.message ?? String(err)}`,
        );
      });
    }

    const status: DlqStatus = {
      dlqDepth: dlqCount,
      totalDeliveries: totalCount,
      dlqPercentage,
      oldestDlqItemAgeMs: oldestAgeMs,
      thresholdBreached,
      alerts,
      checkedAt: now,
    };

    this.logger.debug(
      `DLQ check complete: depth=${dlqCount}, total=${totalCount}, ` +
        `pct=${dlqPercentage.toFixed(2)}%, thresholdBreached=${thresholdBreached}`,
    );

    return status;
  }

  /**
   * Returns current DLQ depth without triggering alert logic.
   * Useful for admin endpoints and health probes.
   */
  async getDlqDepth(): Promise<{
    depth: number;
    total: number;
    percentage: number;
  }> {
    const [depth, total] = await Promise.all([
      this.prisma.webhookDelivery.count({
        where: { status: DeliveryStatus.FAILED },
      }),
      this.prisma.webhookDelivery.count(),
    ]);
    const percentage = total > 0 ? (depth / total) * 100 : 0;
    return { depth, total, percentage };
  }

  /**
   * Returns the configured alert thresholds (for introspection).
   */
  getThresholds(): DlqAlertThresholds {
    return { ...this.thresholds };
  }

  /**
   * Returns whether an ops webhook URL is configured.
   * Useful for health checks and test assertions.
   */
  hasOpsWebhook(): boolean {
    return Boolean(this.opsWebhookUrl);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * POSTs a structured alert payload to DLQ_OPS_WEBHOOK_URL.
   *
   * This method is intentionally non-throwing — any error is caught and logged
   * by the caller so monitoring infrastructure failures cannot interrupt the
   * DLQ check loop itself.
   *
   * The payload follows a generic envelope that works with Slack incoming
   * webhooks (via the `text` field) as well as generic HTTP sinks (the full
   * structured body).
   */
  private async notifyOps(status: Omit<DlqStatus, 'thresholdBreached'>): Promise<void> {
    if (!this.opsWebhookUrl) {
      return; // ops notifications not configured — metrics-only mode
    }

    const summary = status.alerts.map((a) => a.message).join('; ');

    const payload = {
      service: 'mux-backend',
      event: 'dlq.threshold_breached',
      // Slack-compatible `text` field for simple Slack channels
      text: `[mux-backend] DLQ threshold breached: ${summary}`,
      dlqDepth: status.dlqDepth,
      totalDeliveries: status.totalDeliveries,
      dlqPercentage: parseFloat(status.dlqPercentage.toFixed(2)),
      oldestDlqItemAgeMs: status.oldestDlqItemAgeMs,
      alerts: status.alerts,
      checkedAt: status.checkedAt.toISOString(),
    };

    this.logger.log(
      `Sending DLQ ops notification to configured webhook ` +
        `(depth=${status.dlqDepth}, alerts=${status.alerts.length})`,
    );

    await axios.post(this.opsWebhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: this.opsWebhookTimeoutMs,
    });

    this.logger.log('DLQ ops notification delivered successfully');
  }

  private evaluateThresholds(
    dlqCount: number,
    dlqPercentage: number,
    oldestAgeMs: number | null,
  ): DlqAlert[] {
    const alerts: DlqAlert[] = [];

    if (dlqCount >= this.thresholds.absoluteThreshold) {
      alerts.push({
        type: 'ABSOLUTE_THRESHOLD',
        message: `DLQ depth ${dlqCount} has reached the absolute threshold of ${this.thresholds.absoluteThreshold}`,
        value: dlqCount,
        threshold: this.thresholds.absoluteThreshold,
      });
    }

    if (dlqPercentage >= this.thresholds.percentageThreshold) {
      alerts.push({
        type: 'PERCENTAGE_THRESHOLD',
        message: `DLQ percentage ${dlqPercentage.toFixed(2)}% has reached the threshold of ${this.thresholds.percentageThreshold}%`,
        value: dlqPercentage,
        threshold: this.thresholds.percentageThreshold,
      });
    }

    if (
      oldestAgeMs !== null &&
      oldestAgeMs >= this.thresholds.ageThresholdMs
    ) {
      const ageHours = (oldestAgeMs / 3_600_000).toFixed(1);
      const thresholdHours = (
        this.thresholds.ageThresholdMs / 3_600_000
      ).toFixed(1);
      alerts.push({
        type: 'AGE_THRESHOLD',
        message: `Oldest DLQ item is ${ageHours}h old, exceeding the age threshold of ${thresholdHours}h`,
        value: oldestAgeMs,
        threshold: this.thresholds.ageThresholdMs,
      });
    }

    return alerts;
  }

  private recordMetrics(
    dlqDepth: number,
    totalDeliveries: number,
    dlqPercentage: number,
    oldestAgeMs: number | null,
  ): void {
    // Use recordHistogram to track gauge-like values via observations
    this.metrics.recordHistogram('webhook_dlq_depth', dlqDepth, {});
    this.metrics.recordHistogram(
      'webhook_dlq_percentage',
      dlqPercentage,
      {},
    );
    this.metrics.incrementCounter('webhook_dlq_checks_total', {});

    if (oldestAgeMs !== null) {
      this.metrics.recordHistogram(
        'webhook_dlq_oldest_item_age_seconds',
        oldestAgeMs / 1000,
        {},
      );
    }
  }
}
