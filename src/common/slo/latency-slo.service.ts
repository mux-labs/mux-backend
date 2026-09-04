import { Injectable, Logger } from '@nestjs/common';
import {
  SloDefinition,
  SloObservation,
  SloComplianceResult,
  DEFAULT_SLOS,
} from './slo.types';

/**
 * Records HTTP request latency observations and evaluates them against
 * the defined latency SLOs.
 *
 * Observations are kept in a fixed-size rolling window (per SLO bucket)
 * to bound memory usage.  Percentile estimates use a simple sort over the
 * window — adequate for observability dashboards; not a replacement for a
 * true histogram backend.
 */
@Injectable()
export class LatencySloService {
  private readonly logger = new Logger(LatencySloService.name);

  /** Maximum observations stored per SLO bucket. */
  private readonly WINDOW_SIZE = 1000;

  private readonly slos: SloDefinition[];

  /** Map from SLO name → rolling list of latencies (ms). */
  private readonly windows = new Map<string, number[]>();

  constructor(slos: SloDefinition[] = DEFAULT_SLOS) {
    this.slos = slos;
    for (const slo of slos) {
      this.windows.set(slo.name, []);
    }
  }

  /**
   * Record a single latency observation from an incoming request.
   * The observation is assigned to every matching SLO bucket.
   */
  record(observation: SloObservation): void {
    const matchedSlos = this.matchSlos(observation);

    for (const slo of matchedSlos) {
      const window = this.windows.get(slo.name)!;
      window.push(observation.durationMs);

      // Trim to rolling window
      if (window.length > this.WINDOW_SIZE) {
        window.shift();
      }
    }

    this.logger.debug(
      `[slo] ${observation.method} ${observation.route} ${observation.durationMs}ms` +
        ` → matched ${matchedSlos.map((s) => s.name).join(', ')}`,
    );
  }

  /**
   * Compute current compliance for all SLOs.
   */
  getCompliance(): SloComplianceResult[] {
    return this.slos.map((slo) => this.computeCompliance(slo));
  }

  /**
   * Compute current compliance for a single SLO by name.
   * Returns null when the name is not found.
   */
  getComplianceFor(sloName: string): SloComplianceResult | null {
    const slo = this.slos.find((s) => s.name === sloName);
    if (!slo) return null;
    return this.computeCompliance(slo);
  }

  /** Reset all windows (useful in tests). */
  resetWindows(): void {
    for (const key of this.windows.keys()) {
      this.windows.set(key, []);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private matchSlos(obs: SloObservation): SloDefinition[] {
    return this.slos.filter((slo) => this.matchesSlo(slo, obs));
  }

  private matchesSlo(slo: SloDefinition, obs: SloObservation): boolean {
    const methodMatch =
      slo.method === '*' ||
      slo.method.toUpperCase() === obs.method.toUpperCase();

    const routeMatch = obs.route.startsWith(slo.routePrefix);

    return methodMatch && routeMatch;
  }

  private computeCompliance(slo: SloDefinition): SloComplianceResult {
    const window = this.windows.get(slo.name) ?? [];
    const total = window.length;

    if (total === 0) {
      return {
        sloName: slo.name,
        thresholdMs: slo.thresholdMs,
        targetCompliance: slo.targetCompliance,
        measuredCompliance: 1,
        compliant: true,
        totalRequests: 0,
        requestsWithinThreshold: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
      };
    }

    const withinThreshold = window.filter((d) => d <= slo.thresholdMs).length;
    const measuredCompliance = withinThreshold / total;
    const sorted = [...window].sort((a, b) => a - b);

    return {
      sloName: slo.name,
      thresholdMs: slo.thresholdMs,
      targetCompliance: slo.targetCompliance,
      measuredCompliance,
      compliant: measuredCompliance >= slo.targetCompliance,
      totalRequests: total,
      requestsWithinThreshold: withinThreshold,
      p50Ms: this.percentile(sorted, 50),
      p95Ms: this.percentile(sorted, 95),
      p99Ms: this.percentile(sorted, 99),
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }
}
