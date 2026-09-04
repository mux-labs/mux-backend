import { WalletOrchestratorMetricsService } from './wallet-orchestrator-metrics.service';
import { WalletNetwork } from './domain/wallet.model';
import { OrchestrationOutcome, OrchestrationPhase } from './wallet-creation-orchestrator.service';

describe('WalletOrchestratorMetricsService', () => {
  let service: WalletOrchestratorMetricsService;

  beforeEach(() => {
    service = new WalletOrchestratorMetricsService();
  });

  describe('initial state', () => {
    it('starts with zero totalOperations', () => {
      expect(service.getSnapshot().totalOperations).toBe(0);
    });

    it('all outcome buckets start at 0', () => {
      const { outcomes } = service.getSnapshot();
      for (const val of Object.values(outcomes)) {
        expect(val).toBe(0);
      }
    });

    it('lastResetAt is a recent Date', () => {
      const before = Date.now();
      const svc = new WalletOrchestratorMetricsService();
      const after = Date.now();
      const { lastResetAt } = svc.getSnapshot();
      expect(lastResetAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(lastResetAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('record()', () => {
    it('increments totalOperations', () => {
      service.record({ outcome: 'created', durationMs: 100, network: WalletNetwork.TESTNET });
      expect(service.getSnapshot().totalOperations).toBe(1);
    });

    it('increments correct outcome bucket', () => {
      service.record({ outcome: 'created', durationMs: 50, network: WalletNetwork.TESTNET });
      service.record({ outcome: 'created', durationMs: 60, network: WalletNetwork.TESTNET });
      service.record({ outcome: 'failed', durationMs: 10, network: WalletNetwork.TESTNET });

      const { outcomes } = service.getSnapshot();
      expect(outcomes.created).toBe(2);
      expect(outcomes.failed).toBe(1);
      expect(outcomes.existing).toBe(0);
      expect(outcomes.idempotent).toBe(0);
    });

    it('tracks all outcome types', () => {
      const all: OrchestrationOutcome[] = ['created', 'existing', 'idempotent', 'failed'];
      all.forEach((o) => service.record({ outcome: o, durationMs: 10, network: WalletNetwork.TESTNET }));
      const { outcomes } = service.getSnapshot();
      all.forEach((o) => expect(outcomes[o]).toBe(1));
    });

    it('tracks network counts', () => {
      service.record({ outcome: 'created', durationMs: 50, network: WalletNetwork.TESTNET });
      service.record({ outcome: 'created', durationMs: 60, network: WalletNetwork.TESTNET });
      service.record({ outcome: 'created', durationMs: 70, network: WalletNetwork.MAINNET });

      const { networks } = service.getSnapshot();
      expect(networks[WalletNetwork.TESTNET]).toBe(2);
      expect(networks[WalletNetwork.MAINNET]).toBe(1);
    });

    it('tracks failed phase counts', () => {
      const phase: OrchestrationPhase = 'key-generation';
      service.record({ outcome: 'failed', durationMs: 10, network: WalletNetwork.TESTNET, failedPhase: phase });
      service.record({ outcome: 'failed', durationMs: 10, network: WalletNetwork.TESTNET, failedPhase: phase });

      const { failedPhases } = service.getSnapshot();
      expect(failedPhases[phase]).toBe(2);
    });

    it('does not add failedPhase entry when not provided', () => {
      service.record({ outcome: 'created', durationMs: 50, network: WalletNetwork.TESTNET });
      const { failedPhases } = service.getSnapshot();
      expect(Object.keys(failedPhases)).toHaveLength(0);
    });

    it('computes average duration from a single sample', () => {
      service.record({ outcome: 'created', durationMs: 80, network: WalletNetwork.TESTNET });
      expect(service.getSnapshot().averageDurationMs).toBe(80);
    });

    it('computes average duration from multiple samples', () => {
      service.record({ outcome: 'created', durationMs: 100, network: WalletNetwork.TESTNET });
      service.record({ outcome: 'created', durationMs: 200, network: WalletNetwork.TESTNET });
      service.record({ outcome: 'created', durationMs: 300, network: WalletNetwork.TESTNET });
      expect(service.getSnapshot().averageDurationMs).toBe(200);
    });

    it('computes p95 duration correctly', () => {
      for (let i = 1; i <= 20; i++) {
        service.record({ outcome: 'created', durationMs: i, network: WalletNetwork.TESTNET });
      }
      // sorted=[1..20], p95 idx=ceil(0.95*20)-1=18 → value=19
      expect(service.getSnapshot().p95DurationMs).toBe(19);
    });
  });

  describe('reset()', () => {
    it('zeros all counters', () => {
      service.record({ outcome: 'created', durationMs: 100, network: WalletNetwork.TESTNET });
      service.record({ outcome: 'failed', durationMs: 10, network: WalletNetwork.TESTNET, failedPhase: 'key-generation' });
      service.reset();

      const snap = service.getSnapshot();
      expect(snap.totalOperations).toBe(0);
      expect(snap.averageDurationMs).toBe(0);
      expect(snap.p95DurationMs).toBe(0);
      for (const val of Object.values(snap.outcomes)) expect(val).toBe(0);
      expect(Object.keys(snap.networks)).toHaveLength(0);
      expect(Object.keys(snap.failedPhases)).toHaveLength(0);
    });

    it('updates lastResetAt', async () => {
      const before = service.getSnapshot().lastResetAt;
      await new Promise((r) => setTimeout(r, 2));
      service.reset();
      expect(service.getSnapshot().lastResetAt.getTime()).toBeGreaterThan(before.getTime());
    });

    it('allows new recordings after reset', () => {
      service.record({ outcome: 'created', durationMs: 100, network: WalletNetwork.TESTNET });
      service.reset();
      service.record({ outcome: 'existing', durationMs: 5, network: WalletNetwork.MAINNET });

      const snap = service.getSnapshot();
      expect(snap.totalOperations).toBe(1);
      expect(snap.outcomes.existing).toBe(1);
      expect(snap.outcomes.created).toBe(0);
    });
  });

  describe('ring-buffer behaviour', () => {
    it('handles more samples than capacity without throwing', () => {
      for (let i = 0; i < 1100; i++) {
        service.record({ outcome: 'created', durationMs: 100, network: WalletNetwork.TESTNET });
      }
      const snap = service.getSnapshot();
      expect(snap.totalOperations).toBe(1100);
      expect(snap.averageDurationMs).toBe(100);
    });
  });

  describe('getSnapshot() immutability', () => {
    it('returns a copy of outcomes, not a live reference', () => {
      const snap1 = service.getSnapshot();
      service.record({ outcome: 'created', durationMs: 10, network: WalletNetwork.TESTNET });
      const snap2 = service.getSnapshot();
      expect(snap1.outcomes.created).toBe(0);
      expect(snap2.outcomes.created).toBe(1);
    });
  });
});
