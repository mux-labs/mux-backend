import { Injectable, Logger } from '@nestjs/common';
import { WalletNetwork } from './domain/wallet.model';
import { OrchestrationOutcome, OrchestrationPhase } from './wallet-creation-orchestrator.service';

export interface OrchestratorMetricsSnapshot {
  totalOperations: number;
  outcomes: Record<OrchestrationOutcome, number>;
  /** Average duration in ms across all recorded operations */
  averageDurationMs: number;
  /** P95 duration in ms (approximated from recorded samples) */
  p95DurationMs: number;
  /** Counts per network */
  networks: Record<string, number>;
  /** Failed phase breakdown */
  failedPhases: Partial<Record<OrchestrationPhase, number>>;
  lastResetAt: Date;
}

/**
 * In-process metrics store for the WalletCreationOrchestrator.
 *
 * Tracks operation counts, latency samples, outcome distribution, and
 * per-network/per-phase counters. All state is in-memory; no external
 * dependency is required.
 */
@Injectable()
export class WalletOrchestratorMetricsService {
  private readonly logger = new Logger(WalletOrchestratorMetricsService.name);

  private static readonly MAX_DURATION_SAMPLES = 1_000;

  private totalOperations = 0;
  private readonly outcomeCounts: Record<OrchestrationOutcome, number> = {
    created: 0,
    existing: 0,
    idempotent: 0,
    failed: 0,
  };
  private readonly networkCounts: Record<string, number> = {};
  private readonly failedPhaseCounts: Partial<Record<OrchestrationPhase, number>> = {};

  private readonly durationSamples: number[] = [];
  private durationIndex = 0;
  private lastResetAt: Date = new Date();

  /**
   * Records one completed orchestration operation.
   */
  record(opts: {
    outcome: OrchestrationOutcome;
    durationMs: number;
    network: WalletNetwork;
    failedPhase?: OrchestrationPhase;
  }): void {
    this.totalOperations++;
    this.outcomeCounts[opts.outcome]++;

    const netKey = opts.network as string;
    this.networkCounts[netKey] = (this.networkCounts[netKey] ?? 0) + 1;

    if (opts.failedPhase) {
      this.failedPhaseCounts[opts.failedPhase] =
        (this.failedPhaseCounts[opts.failedPhase] ?? 0) + 1;
    }

    this.recordDuration(opts.durationMs);

    this.logger.debug(
      `wallet.orchestrator outcome=${opts.outcome} network=${opts.network} durationMs=${opts.durationMs}`,
    );
  }

  /**
   * Returns a point-in-time snapshot of all counters.
   */
  getSnapshot(): OrchestratorMetricsSnapshot {
    return {
      totalOperations: this.totalOperations,
      outcomes: { ...this.outcomeCounts },
      averageDurationMs: this.computeAverage(),
      p95DurationMs: this.computePercentile(95),
      networks: { ...this.networkCounts },
      failedPhases: { ...this.failedPhaseCounts },
      lastResetAt: this.lastResetAt,
    };
  }

  /**
   * Resets all counters and samples. Useful for tests and scheduled resets.
   */
  reset(): void {
    this.totalOperations = 0;
    for (const k of Object.keys(this.outcomeCounts) as OrchestrationOutcome[]) {
      this.outcomeCounts[k] = 0;
    }
    for (const k of Object.keys(this.networkCounts)) {
      delete this.networkCounts[k];
    }
    for (const k of Object.keys(this.failedPhaseCounts) as OrchestrationPhase[]) {
      delete this.failedPhaseCounts[k];
    }
    this.durationSamples.length = 0;
    this.durationIndex = 0;
    this.lastResetAt = new Date();
    this.logger.log('Wallet orchestrator metrics counters reset');
  }

  private recordDuration(ms: number): void {
    if (this.durationSamples.length < WalletOrchestratorMetricsService.MAX_DURATION_SAMPLES) {
      this.durationSamples.push(ms);
    } else {
      this.durationSamples[
        this.durationIndex % WalletOrchestratorMetricsService.MAX_DURATION_SAMPLES
      ] = ms;
    }
    this.durationIndex++;
  }

  private computeAverage(): number {
    if (this.durationSamples.length === 0) return 0;
    const sum = this.durationSamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.durationSamples.length);
  }

  private computePercentile(pct: number): number {
    if (this.durationSamples.length === 0) return 0;
    const sorted = [...this.durationSamples].sort((a, b) => a - b);
    const idx = Math.ceil((pct / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
