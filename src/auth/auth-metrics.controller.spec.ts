import { Test, TestingModule } from '@nestjs/testing';
import { AuthMetricsController } from './auth-metrics.controller';
import { AuthMetricsService, AuthMetricsSnapshot } from './auth-metrics.service';

const makeSnapshot = (overrides: Partial<AuthMetricsSnapshot> = {}): AuthMetricsSnapshot => ({
  totalAttempts: 0,
  outcomes: {
    success_new_user: 0,
    success_returning_user: 0,
    failure_invalid_payload: 0,
    failure_user_inactive: 0,
    failure_wallet_error: 0,
    failure_jwt_verification: 0,
    failure_unknown: 0,
  },
  rateLimitHits: 0,
  averageLatencyMs: 0,
  p95LatencyMs: 0,
  lastResetAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('AuthMetricsController', () => {
  let controller: AuthMetricsController;
  let metricsService: jest.Mocked<AuthMetricsService>;

  beforeEach(async () => {
    metricsService = {
      recordAttempt: jest.fn(),
      recordRateLimitHit: jest.fn(),
      getSnapshot: jest.fn(),
      reset: jest.fn(),
    } as unknown as jest.Mocked<AuthMetricsService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthMetricsController],
      providers: [{ provide: AuthMetricsService, useValue: metricsService }],
    }).compile();

    controller = module.get(AuthMetricsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getMetrics()', () => {
    it('delegates to AuthMetricsService.getSnapshot()', () => {
      const snap = makeSnapshot({ totalAttempts: 42, rateLimitHits: 3 });
      metricsService.getSnapshot.mockReturnValue(snap);

      const result = controller.getMetrics();

      expect(metricsService.getSnapshot).toHaveBeenCalledTimes(1);
      expect(result).toEqual(snap);
    });

    it('returns a snapshot with all expected fields', () => {
      const snap = makeSnapshot({
        totalAttempts: 10,
        averageLatencyMs: 120,
        p95LatencyMs: 300,
        outcomes: {
          success_new_user: 3,
          success_returning_user: 5,
          failure_invalid_payload: 1,
          failure_user_inactive: 0,
          failure_wallet_error: 0,
          failure_jwt_verification: 0,
          failure_unknown: 1,
        },
      });
      metricsService.getSnapshot.mockReturnValue(snap);

      const result = controller.getMetrics();
      expect(result.totalAttempts).toBe(10);
      expect(result.averageLatencyMs).toBe(120);
      expect(result.p95LatencyMs).toBe(300);
      expect(result.outcomes.success_new_user).toBe(3);
    });

    it('returns zero-state snapshot when no auth has occurred', () => {
      metricsService.getSnapshot.mockReturnValue(makeSnapshot());
      const result = controller.getMetrics();
      expect(result.totalAttempts).toBe(0);
      expect(result.rateLimitHits).toBe(0);
    });
  });
});
