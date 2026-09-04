import { Test, TestingModule } from '@nestjs/testing';
import { TransactionMetricsService } from './transaction-metrics.service';

describe('TransactionMetricsService', () => {
  let service: TransactionMetricsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TransactionMetricsService],
    }).compile();

    service = module.get<TransactionMetricsService>(TransactionMetricsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getSnapshot initial state', () => {
    it('returns all-zero counters when no events have been recorded', () => {
      const snap = service.getSnapshot();
      expect(snap.transactionsCreatedTotal).toBe(0);
      expect(snap.transactionsStatusUpdatedTotal).toBe(0);
      expect(snap.transactionsFailedTotal).toBe(0);
      expect(snap.idempotencyHitsTotal).toBe(0);
      expect(snap.cacheHitsTotal).toBe(0);
      expect(snap.cacheMissesTotal).toBe(0);
      expect(snap.transactionsCreatedByAsset).toEqual({});
      expect(snap.transactionsStatusUpdatedByTransition).toEqual({});
    });
  });

  describe('incrementTransactionCreated', () => {
    it('increments total counter', () => {
      service.incrementTransactionCreated('NATIVE');
      expect(service.getSnapshot().transactionsCreatedTotal).toBe(1);
    });

    it('tracks per-asset-type counts', () => {
      service.incrementTransactionCreated('NATIVE');
      service.incrementTransactionCreated('NATIVE');
      service.incrementTransactionCreated('TOKEN');

      const snap = service.getSnapshot();
      expect(snap.transactionsCreatedTotal).toBe(3);
      expect(snap.transactionsCreatedByAsset).toEqual({
        NATIVE: 2,
        TOKEN: 1,
      });
    });

    it('returns a copy of the asset map so the snapshot is immutable', () => {
      service.incrementTransactionCreated('NATIVE');
      const snap = service.getSnapshot();
      snap.transactionsCreatedByAsset['NATIVE'] = 999;
      expect(service.getSnapshot().transactionsCreatedByAsset['NATIVE']).toBe(
        1,
      );
    });
  });

  describe('incrementStatusUpdated', () => {
    it('increments total and records the transition key', () => {
      service.incrementStatusUpdated('PENDING', 'SUBMITTED');

      const snap = service.getSnapshot();
      expect(snap.transactionsStatusUpdatedTotal).toBe(1);
      expect(snap.transactionsStatusUpdatedByTransition).toEqual({
        PENDING_to_SUBMITTED: 1,
      });
    });

    it('increments transactionsFailedTotal when toStatus is FAILED', () => {
      service.incrementStatusUpdated('PENDING', 'FAILED');

      const snap = service.getSnapshot();
      expect(snap.transactionsFailedTotal).toBe(1);
    });

    it('does not increment transactionsFailedTotal for non-FAILED transitions', () => {
      service.incrementStatusUpdated('PENDING', 'SUBMITTED');
      expect(service.getSnapshot().transactionsFailedTotal).toBe(0);
    });

    it('accumulates multiple different transitions', () => {
      service.incrementStatusUpdated('PENDING', 'SUBMITTED');
      service.incrementStatusUpdated('SUBMITTED', 'CONFIRMED');
      service.incrementStatusUpdated('PENDING', 'SUBMITTED');

      const snap = service.getSnapshot();
      expect(snap.transactionsStatusUpdatedTotal).toBe(3);
      expect(snap.transactionsStatusUpdatedByTransition).toEqual({
        PENDING_to_SUBMITTED: 2,
        SUBMITTED_to_CONFIRMED: 1,
      });
    });
  });

  describe('incrementIdempotencyHit', () => {
    it('increments idempotencyHitsTotal', () => {
      service.incrementIdempotencyHit();
      service.incrementIdempotencyHit();
      expect(service.getSnapshot().idempotencyHitsTotal).toBe(2);
    });
  });

  describe('incrementCacheHit', () => {
    it('increments cacheHitsTotal', () => {
      service.incrementCacheHit();
      expect(service.getSnapshot().cacheHitsTotal).toBe(1);
    });
  });

  describe('incrementCacheMiss', () => {
    it('increments cacheMissesTotal', () => {
      service.incrementCacheMiss();
      service.incrementCacheMiss();
      expect(service.getSnapshot().cacheMissesTotal).toBe(2);
    });
  });

  describe('getSnapshot', () => {
    it('returns independent copies so mutations do not affect internal state', () => {
      service.incrementStatusUpdated('PENDING', 'SUBMITTED');
      const snap = service.getSnapshot();
      snap.transactionsStatusUpdatedByTransition['PENDING_to_SUBMITTED'] = 999;
      expect(
        service.getSnapshot().transactionsStatusUpdatedByTransition[
          'PENDING_to_SUBMITTED'
        ],
      ).toBe(1);
    });
  });
});
