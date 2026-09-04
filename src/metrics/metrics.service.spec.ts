import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;
  let paymentsCreatedCounter: any;
  let paymentsFailedCounter: any;
  let paymentProcessingHistogram: any;
  let limitExceededCounter: any;
  let limitChecksCounter: any;
  let paymentIdempotencyHitsCounter: any;

  beforeEach(() => {
    const labeledCounter = { inc: jest.fn() };
    paymentsCreatedCounter = { inc: jest.fn() };
    paymentsFailedCounter = { labels: jest.fn().mockReturnValue(labeledCounter) };
    paymentProcessingHistogram = { observe: jest.fn() };
    limitExceededCounter = { labels: jest.fn().mockReturnValue(labeledCounter) };
    limitChecksCounter = { labels: jest.fn().mockReturnValue(labeledCounter) };
    paymentIdempotencyHitsCounter = { inc: jest.fn() };

    service = new MetricsService(
      paymentsCreatedCounter,
      paymentsFailedCounter,
      paymentProcessingHistogram,
      limitExceededCounter,
      limitChecksCounter,
      paymentIdempotencyHitsCounter,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('payments metrics', () => {
    it('should increment payments_created_total counter', () => {
      service.incrementPaymentsCreated();
      expect(paymentsCreatedCounter.inc).toHaveBeenCalled();
    });

    it('should increment payments_failed_total counter with reason label', () => {
      service.incrementPaymentsFailed('timeout');

      expect(paymentsFailedCounter.labels).toHaveBeenCalledWith('timeout');
    });

    it('should record payment processing duration', () => {
      service.recordPaymentProcessingDuration(1500);

      expect(paymentProcessingHistogram.observe).toHaveBeenCalledWith(1.5);
    });
  });

  describe('limit metrics', () => {
    it('should increment limit_exceeded_total counter with limit_type label', () => {
      service.incrementLimitExceeded('daily');

      expect(limitExceededCounter.labels).toHaveBeenCalledWith('daily');
    });

    it('should increment limit_checks_total counter with result label', () => {
      service.incrementLimitChecks('allowed');

      expect(limitChecksCounter.labels).toHaveBeenCalledWith('allowed');
    });
  });

  describe('payment idempotency metrics', () => {
    it('should increment payment_idempotency_hits_total counter', () => {
      service.incrementPaymentIdempotencyHit();

      expect(paymentIdempotencyHitsCounter.inc).toHaveBeenCalled();
    });
  });
});
