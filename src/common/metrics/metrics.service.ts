import { Injectable, Logger } from '@nestjs/common';

const MAX_SERIES_PER_METRIC = 1000;
const DROPPED_SERIES_METRIC = 'metrics_series_dropped_total';

interface MetricSeries {
  labels: Record<string, string>;
  value: number;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  /**
   * In-memory counter registry so exported values can be scraped/asserted.
   * Keyed by the sanitized metric name (which may include bounded labels).
   */
  private readonly counters = new Map<string, number>();

  /**
   * In-memory histogram registry so exported values can be scraped/asserted.
   * Keyed by the sanitized metric name (which may include bounded labels).
   */
  private readonly histograms = new Map<string, MetricSeries>();

  /**
   * Increment a named counter by the given amount.
   * Labels are sanitized to be log-safe.
   */
  incrementCounter(name: string, value: number = 1): void {
    const safeName = this.sanitizeLabel(name);
    this.counters.set(safeName, (this.counters.get(safeName) ?? 0) + value);
    this.logger.debug(`counter_inc ${safeName}=${value}`);
  }

  /**
   * Read the current value of a counter (0 when never incremented).
   */
  getCounter(name: string): number {
    return this.counters.get(this.sanitizeLabel(name)) ?? 0;
  }

  /**
   * Snapshot of all counters, suitable for a scrape/export path.
   */
  getCounters(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /**
   * Record a histogram observation.
   */
  recordHistogram(name: string, value: number): void {
    const safeName = this.sanitizeLabel(name);
    this.logger.debug(`histogram ${safeName}=${value}`);
  }

  render(): string {
    const lines: string[] = [];

    for (const [key, series] of this.counters) {
      lines.push(this.formatLine(key, series));
    }

    for (const [key, series] of this.histograms) {
      lines.push(this.formatLine(key, series));
    }

    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }

  private record(
    registry: Map<string, MetricSeries>,
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): void {
    const sanitizedName = sanitizeLabel(name);
    const sanitizedLabels = sanitizeLabels(labels);
    const key = seriesKey(sanitizedName, sanitizedLabels);

    const existing = registry.get(key);
    if (existing) {
      existing.value += value;
      return;
    }

    if (registry.size >= MAX_SERIES_PER_METRIC) {
      this.incrementDroppedSeries();
      this.logger.debug(
        `Dropped metric series for ${sanitizedName}: series cap of ${MAX_SERIES_PER_METRIC} reached`,
      );
      return;
    }

    registry.set(key, { labels: sanitizedLabels, value });
  }

  private incrementDroppedSeries(): void {
    const key = seriesKey(DROPPED_SERIES_METRIC, {});
    const existing = this.counters.get(key);

    if (existing) {
      existing.value += 1;
      return;
    }

    this.counters.set(key, { labels: {}, value: 1 });
  }

  private formatLine(key: string, series: MetricSeries): string {
    const name = key.split('|')[0];
    const labelEntries = Object.entries(series.labels);

    if (labelEntries.length === 0) {
      return `${name} ${series.value}`;
    }

    const rendered = labelEntries
      .map(([label, labelValue]) => `${label}="${labelValue}"`)
      .join(',');

    return `${name}{${rendered}} ${series.value}`;
  }
}

function sanitizeLabels(
  labels?: Record<string, string>,
): Record<string, string> {
  if (!labels) {
    return {};
  }

  const sanitized: Record<string, string> = {};
  for (const label of Object.keys(labels).sort()) {
    sanitized[sanitizeLabel(label)] = sanitizeLabel(String(labels[label]));
  }

  return sanitized;
}

function seriesKey(
  name: string,
  labels: Record<string, string>,
): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((label) => `${label}="${labels[label]}"`)
    .join(',');

  return `${name}|${pairs}`;
}

function sanitizeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}
