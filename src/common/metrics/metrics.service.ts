import { Injectable, Logger } from '@nestjs/common';
import { MetricsLabelGuardService } from './label-cardinality-guard';

export interface MetricsCollector {
  incrementCounter(name: string, labels?: Record<string, string>): void;
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
}

/**
 * Metrics service using prom-client for Prometheus instrumentation
 * Provides a simple interface for registering and recording metrics.
 *
 * All labels are validated through MetricsLabelGuardService to prevent
 * high-cardinality label values (wallet IDs, tx hashes, UUIDs, etc.) from
 * exploding Prometheus series counts in production.
 */
@Injectable()
export class MetricsService implements MetricsCollector {
  private readonly logger = new Logger(MetricsService.name);
  private counters: Map<string, any> = new Map();
  private histograms: Map<string, any> = new Map();
  private readonly labelNames: Map<string, Set<string>> = new Map();

  constructor(private readonly labelGuard: MetricsLabelGuardService) {
    // Metrics will be initialized on demand
  }

  /**
   * Registers or retrieves a counter metric
   * Normalizes label names upfront to prevent prom-client mismatches
   */
  private getOrCreateCounter(name: string, help: string, labels: string[] = []) {
    if (!this.counters.has(name)) {
      const Counter = require('prom-client').Counter;
      try {
        const counter = new Counter({
          name,
          help,
          labelNames: labels,
        });
        this.counters.set(name, counter);
        this.labelNames.set(`counter_${name}`, new Set(labels));
      } catch (error) {
        this.logger.error(
          `Failed to create counter "${name}": ${error.message}. ` +
            `This may be due to label name mismatches. Ensure all calls use consistent label sets.`,
        );
        throw error;
      }
    }
    return this.counters.get(name);
  }

  /**
   * Registers or retrieves a histogram metric
   * Normalizes label names upfront to prevent prom-client mismatches
   */
  private getOrCreateHistogram(name: string, help: string, labels: string[] = []) {
    if (!this.histograms.has(name)) {
      const Histogram = require('prom-client').Histogram;
      try {
        const histogram = new Histogram({
          name,
          help,
          labelNames: labels,
          buckets: [0.1, 0.5, 1, 2, 5, 10], // seconds
        });
        this.histograms.set(name, histogram);
        this.labelNames.set(`histogram_${name}`, new Set(labels));
      } catch (error) {
        this.logger.error(
          `Failed to create histogram "${name}": ${error.message}. ` +
            `This may be due to label name mismatches. Ensure all calls use consistent label sets.`,
        );
        throw error;
      }
    }
    return this.histograms.get(name);
  }

  /**
   * Increments a counter with optional labels
   * All labels are validated through the cardinality guard
   */
  incrementCounter(name: string, labels?: Record<string, string>): void {
    try {
      // Validate and sanitize labels through the guard
      const sanitized = labels
        ? this.labelGuard.validateAndSanitizeLabels(name, labels)
        : {};

      const labelNames = Object.keys(sanitized);
      const counter = this.getOrCreateCounter(name, name, labelNames);

      if (labelNames.length > 0) {
        counter.inc(sanitized);
      } else {
        counter.inc();
      }
    } catch (error) {
      // In dev/test, propagate guard errors; in production, log and continue
      if (process.env.NODE_ENV !== 'production') {
        throw error;
      }
      this.logger.error(
        `Error recording counter "${name}": ${error.message}`,
      );
    }
  }

  /**
   * Records a histogram value with optional labels (in seconds)
   * All labels are validated through the cardinality guard
   */
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    try {
      // Validate and sanitize labels through the guard
      const sanitized = labels
        ? this.labelGuard.validateAndSanitizeLabels(name, labels)
        : {};

      const labelNames = Object.keys(sanitized);
      const histogram = this.getOrCreateHistogram(name, name, labelNames);

      if (labelNames.length > 0) {
        histogram.observe(sanitized, value);
      } else {
        histogram.observe(value);
      }
    } catch (error) {
      // In dev/test, propagate guard errors; in production, log and continue
      if (process.env.NODE_ENV !== 'production') {
        throw error;
      }
      this.logger.error(
        `Error recording histogram "${name}": ${error.message}`,
      );
    }
  }

  /**
   * Gets all registered metrics for Prometheus scraping
   */
  getMetrics(): string {
    try {
      const register = require('prom-client').register;
      return register.metrics();
    } catch (error) {
      this.logger.error(`Failed to get metrics: ${error.message}`);
      throw error;
    }
  }

  /**
   * Gets cardinality statistics for monitoring/debugging (useful for capacity planning)
   */
  getCardinalityStats(): Record<string, { distinctCombinations: number }> {
    return this.labelGuard.getCardinalityStats();
  }
}
