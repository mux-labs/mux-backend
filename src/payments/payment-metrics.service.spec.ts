import { PaymentMetricsService } from './payment-metrics.service';

describe('PaymentMetricsService', () => {
  let svc: PaymentMetricsService;
  beforeEach(() => { svc = new PaymentMetricsService(); });
  afterEach(() => svc.reset());

  it('records a successful create and reflects in snapshot', () => {
    svc.record({ operation: 'create', outcome: 'success', durationMs: 120, currency: 'USD' });
    const s = svc.getSnapshot();
    expect(s.totalOperations).toBe(1);
    expect(s.outcomeBreakdown.success).toBe(1);
    expect(s.outcomeBreakdown.failure).toBe(0);
    expect(s.operationBreakdown.create).toBe(1);
  });

  it('records a failure with reason and increments failure counter', () => {
    svc.record({ operation: 'create', outcome: 'failure', durationMs: 80, failureReason: 'BadRequestException' });
    const s = svc.getSnapshot();
    expect(s.outcomeBreakdown.failure).toBe(1);
    expect(s.outcomeBreakdown.success).toBe(0);
    expect(s).not.toHaveProperty('failureReason'); // reason stays in logs, not snapshot
  });

  it('records idempotent separately from success', () => {
    svc.record({ operation: 'create', outcome: 'idempotent', durationMs: 10 });
    expect(svc.getSnapshot().outcomeBreakdown.idempotent).toBe(1);
    expect(svc.getSnapshot().outcomeBreakdown.success).toBe(0);
  });

  it('computes averageDurationMs', () => {
    svc.record({ operation: 'create', outcome: 'success', durationMs: 100 });
    svc.record({ operation: 'create', outcome: 'success', durationMs: 300 });
    expect(svc.getSnapshot().averageDurationMs).toBe(200);
  });

  it('resets all counters', () => {
    svc.record({ operation: 'create', outcome: 'success', durationMs: 100 });
    svc.reset();
    const s = svc.getSnapshot();
    expect(s.totalOperations).toBe(0);
    expect(s.averageDurationMs).toBe(0);
  });
});
