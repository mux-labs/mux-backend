import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { DeveloperQuotaGuard } from './developer-quota.guard';
import {
  DEFAULT_DEVELOPER_QUOTA_RPM,
  DEFAULT_DEVELOPER_QUOTA_WINDOW_MS,
  DeveloperQuotaErrorCode,
  MAX_DEVELOPER_QUOTA_RPM,
  MAX_TRACKED_DEVELOPERS,
  MAX_QUOTA_CLEANUP_BATCH_SIZE,
  RateLimitService,
  RATE_LIMIT_RECORD_STORE,
  resolveDeveloperQuotaConfig,
} from './rate-limit.service';
import { MetricsService } from '../common/metrics/metrics.service';

const DEV_A = 'developer-a';
const DEV_B = 'developer-b';

describe('RateLimitService (per-developer quotas, #955)', () => {
  let service: RateLimitService;
  let store: { rateLimitRecord: { deleteMany: jest.Mock } };
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    store = {
      rateLimitRecord: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new RateLimitService(store, new MetricsService());
    service.reset();
  });

  afterEach(() => {
    process.env = originalEnv;
    service.reset();
  });

  /** Quotas on, with a small limit so tests stay readable. */
  const enabled = (limitRpm: number, windowMs = 60_000): NodeJS.ProcessEnv => ({
    DEVELOPER_QUOTAS_ENABLED: 'true',
    DEVELOPER_QUOTA_DEFAULT_RPM: String(limitRpm),
    DEVELOPER_QUOTA_WINDOW_MS: String(windowMs),
  });

  describe('resolveDeveloperQuotaConfig()', () => {
    it('is disabled by default (deny-by-default)', () => {
      expect(resolveDeveloperQuotaConfig({}).enabled).toBe(false);
      expect(
        resolveDeveloperQuotaConfig({ DEVELOPER_QUOTAS_ENABLED: 'no' }).enabled,
      ).toBe(false);
      expect(
        resolveDeveloperQuotaConfig({ DEVELOPER_QUOTAS_ENABLED: '1' }).enabled,
      ).toBe(true);
    });

    it('returns the documented defaults when nothing is set', () => {
      expect(resolveDeveloperQuotaConfig({})).toEqual({
        enabled: false,
        limitRpm: DEFAULT_DEVELOPER_QUOTA_RPM,
        windowMs: DEFAULT_DEVELOPER_QUOTA_WINDOW_MS,
      });
    });

    it('clamps the limit to a sane range', () => {
      expect(
        resolveDeveloperQuotaConfig({ DEVELOPER_QUOTA_DEFAULT_RPM: '0' })
          .limitRpm,
      ).toBe(1);
      expect(
        resolveDeveloperQuotaConfig({ DEVELOPER_QUOTA_DEFAULT_RPM: '-10' })
          .limitRpm,
      ).toBe(1);
      expect(
        resolveDeveloperQuotaConfig({
          DEVELOPER_QUOTA_DEFAULT_RPM: '99999999',
        }).limitRpm,
      ).toBe(MAX_DEVELOPER_QUOTA_RPM);
    });

    it('falls back to the default for a non-integer limit', () => {
      expect(
        resolveDeveloperQuotaConfig({ DEVELOPER_QUOTA_DEFAULT_RPM: 'lots' })
          .limitRpm,
      ).toBe(DEFAULT_DEVELOPER_QUOTA_RPM);
    });

    it('never allows a zero or negative window', () => {
      expect(
        resolveDeveloperQuotaConfig({ DEVELOPER_QUOTA_WINDOW_MS: '0' })
          .windowMs,
      ).toBe(1);
      expect(
        resolveDeveloperQuotaConfig({ DEVELOPER_QUOTA_WINDOW_MS: '-5' })
          .windowMs,
      ).toBe(1);
    });

    it('lets an operator tighten the ceiling for every developer at once', () => {
      // The emergency brake: lower the ceiling below the default limit and the
      // default quota follows it down.
      expect(
        resolveDeveloperQuotaConfig({
          DEVELOPER_QUOTA_MAX_RPM: '50',
          DEVELOPER_QUOTA_DEFAULT_RPM: '600',
        }).limitRpm,
      ).toBe(50);
    });

    it('never lets configuration raise the ceiling past the hard cap', () => {
      expect(
        resolveDeveloperQuotaConfig({
          DEVELOPER_QUOTA_MAX_RPM: '9999999',
          DEVELOPER_QUOTA_DEFAULT_RPM: '9999999',
        }).limitRpm,
      ).toBe(MAX_DEVELOPER_QUOTA_RPM);
    });
  });
  describe('consume()', () => {
    it('admits everything when quotas are disabled', () => {
      for (let i = 0; i < 50; i += 1) {
        expect(service.consume(DEV_A, {}, 1000).allowed).toBe(true);
      }
    });

    it('admits up to the limit, then denies', () => {
      const env = enabled(3);

      expect(service.consume(DEV_A, env, 1000).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 1001).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 1002).allowed).toBe(true);
      const denied = service.consume(DEV_A, env, 1003);

      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.limitRpm).toBe(3);
    });

    it('reports the remaining allowance and a reset time', () => {
      const env = enabled(5, 60_000);

      expect(service.consume(DEV_A, env, 1000).remaining).toBe(4);
      expect(service.consume(DEV_A, env, 1000).remaining).toBe(3);
      expect(service.consume(DEV_A, env, 1000).resetAt).toBe(61_000);
    });

    it('counts all of a developer keys and projects against one quota', () => {
      // A developer with several keys must not get several times the quota.
      const env = enabled(2);

      expect(service.consume(DEV_A, env, 1000).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 1001).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 1002).allowed).toBe(false);
    });

    it('keeps each developer independent', () => {
      const env = enabled(1);

      expect(service.consume(DEV_A, env, 1000).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 1001).allowed).toBe(false);
      // Developer B is unaffected by developer A exhausting their quota.
      expect(service.consume(DEV_B, env, 1002).allowed).toBe(true);
    });

    it('frees capacity as the sliding window advances', () => {
      const env = enabled(2, 1000);

      expect(service.consume(DEV_A, env, 1000).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 1500).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 1600).allowed).toBe(false);
      // At 2100 the 1000 entry has left the 1000ms window, freeing one slot.
      expect(service.consume(DEV_A, env, 2100).allowed).toBe(true);
      // ...and that consumes it again: 1500 and 2100 are both still in window.
      expect(service.consume(DEV_A, env, 2200).allowed).toBe(false);
      // At 3000 the 1500 entry has also left the window.
      expect(service.consume(DEV_A, env, 3000).allowed).toBe(true);
      expect(service.consume(DEV_A, env, 3100).allowed).toBe(true);
    });

    it('fails closed for a request with no resolved developer id', () => {
      const env = enabled(10);

      // An unattributable request cannot be proven to be within a quota.
      expect(service.consume('', env, 1000).allowed).toBe(false);
      expect(
        service.consume(undefined as unknown as string, env, 1000).allowed,
      ).toBe(false);
    });

    it('never leaks the developer id into the decision', () => {
      const env = enabled(1);
      service.consume(DEV_A, env, 1000);
      const denied = service.consume(DEV_A, env, 1001);

      expect(JSON.stringify(denied)).not.toContain(DEV_A);
    });

    it('bounds the tracked-developer map so a flood cannot exhaust memory', () => {
      const env = enabled(5);
      for (let i = 0; i < MAX_TRACKED_DEVELOPERS + 50; i += 1) {
        service.consume(`dev-${i}`, env, 1000);
      }
      // Eviction costs accuracy, not availability: the service is still usable.
      expect(service.consume('dev-final', env, 1000).allowed).toBe(true);
    });
  });

  describe('cleanupOldRecords()', () => {
    it('deletes only rows whose window has closed', async () => {
      const now = new Date('2026-01-01T00:02:00.000Z');
      await service.cleanupOldRecords(60_000, 100, now);

      // windowStart strictly less than now - windowMs; a current-window row is
      // still enforcing a limit and must survive.
      expect(store.rateLimitRecord.deleteMany).toHaveBeenCalledWith({
        where: { windowStart: { lt: new Date('2026-01-01T00:01:00.000Z') } },
        take: 100,
      });
    });

    it('clamps the batch size', async () => {
      await service.cleanupOldRecords(
        60_000,
        MAX_QUOTA_CLEANUP_BATCH_SIZE + 1000,
      );

      const [args] = store.rateLimitRecord.deleteMany.mock.calls[0] as [
        { take?: number },
      ];
      expect(args.take).toBe(MAX_QUOTA_CLEANUP_BATCH_SIZE);
    });

    it('fails closed with a stable code on a database outage', async () => {
      store.rateLimitRecord.deleteMany.mockRejectedValue(
        new Error('connection refused'),
      );

      await expect(service.cleanupOldRecords()).rejects.toMatchObject({
        code: DeveloperQuotaErrorCode.CLEANUP_DEPENDENCY_UNAVAILABLE,
      });
    });

    it('rejects a non-positive batch size or window', async () => {
      await expect(service.cleanupOldRecords(60_000, 0)).rejects.toMatchObject({
        code: DeveloperQuotaErrorCode.CLEANUP_INVALID_BATCH_SIZE,
      });
      await expect(
        service.cleanupOldRecords(60_000, 1.5),
      ).rejects.toMatchObject({
        code: DeveloperQuotaErrorCode.CLEANUP_INVALID_BATCH_SIZE,
      });
      await expect(service.cleanupOldRecords(0)).rejects.toMatchObject({
        code: DeveloperQuotaErrorCode.CLEANUP_INVALID_BATCH_SIZE,
      });
    });

    it('returns the deleted count and never invents a success', async () => {
      store.rateLimitRecord.deleteMany.mockResolvedValue({ count: 7 });

      await expect(service.cleanupOldRecords()).resolves.toBe(7);
    });
  });

  describe('usage() / reset()', () => {
    it('reports current window occupancy and clears on reset', () => {
      const env = enabled(10);
      service.consume(DEV_A, env, 1000);
      service.consume(DEV_A, env, 1100);

      expect(service.usage(DEV_A, 60_000, 1200)).toBe(2);
      service.reset();
      expect(service.usage(DEV_A, 60_000, 1200)).toBe(0);
    });
  });
});

describe('DeveloperQuotaGuard (#955)', () => {
  let service: RateLimitService;
  let guard: DeveloperQuotaGuard;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    service = new RateLimitService(
      { rateLimitRecord: { deleteMany: jest.fn() } },
      new MetricsService(),
    );
    service.reset();
    guard = new DeveloperQuotaGuard(service);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const enableQuota = (limitRpm: number): void => {
    process.env.DEVELOPER_QUOTAS_ENABLED = 'true';
    process.env.DEVELOPER_QUOTA_DEFAULT_RPM = String(limitRpm);
    process.env.DEVELOPER_QUOTA_WINDOW_MS = '60000';
  };

  /**
   * A request carrying an authenticated API key context. The body and query
   * deliberately claim a different developer, as an attacker would.
   */
  const requestFor = (developerId?: string) => {
    const headersSet = new Map<string, string>();
    return {
      apiKey: developerId ? { developer: { id: developerId } } : undefined,
      body: { developerId: 'attacker-supplied' },
      query: { developerId: 'attacker-supplied' },
      set: (name: string, value: string) => headersSet.set(name, value),
      headersSet,
    };
  };

  const contextFor = (request: unknown) => ({
    switchToHttp: () => ({ getRequest: () => request }),
  });

  it('allows everything when quotas are disabled', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(guard.canActivate(contextFor(requestFor(DEV_A)) as never)).toBe(
        true,
      );
    }
  });

  it('allows up to the limit and then throws a 429', () => {
    enableQuota(2);

    expect(guard.canActivate(contextFor(requestFor(DEV_A)) as never)).toBe(
      true,
    );
    expect(guard.canActivate(contextFor(requestFor(DEV_A)) as never)).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor(requestFor(DEV_A)) as never),
    ).toThrow(HttpException);
  });

  it('throws an actionable 429 with a stable code and Retry-After', () => {
    enableQuota(1);
    guard.canActivate(contextFor(requestFor(DEV_A)) as never);

    try {
      guard.canActivate(contextFor(requestFor(DEV_A)) as never);
      throw new Error('expected a 429');
    } catch (err) {
      const response = (err as HttpException).getResponse() as {
        errorCode: string;
        retryAfterSeconds: number;
      };
      expect(response.errorCode).toBe(DeveloperQuotaErrorCode.EXCEEDED);
      expect(response.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('ignores a client-supplied developerId and uses the authenticated one', () => {
    enableQuota(1);

    expect(guard.canActivate(contextFor(requestFor(DEV_A)) as never)).toBe(
      true,
    );
    // The request claims a different developer in both body and query; the
    // guard must still charge the key that actually authenticated.
    expect(() =>
      guard.canActivate(contextFor(requestFor(DEV_A)) as never),
    ).toThrow(HttpException);
  });

  it('does not let a claimed id borrow another developer quota', () => {
    enableQuota(1);
    guard.canActivate(contextFor(requestFor(DEV_A)) as never);
    // Developer B has used nothing, so B is still admitted.
    expect(guard.canActivate(contextFor(requestFor(DEV_B)) as never)).toBe(
      true,
    );
  });

  it('fails closed when the request has no resolved developer', () => {
    enableQuota(10);

    expect(() =>
      guard.canActivate(contextFor(requestFor(undefined)) as never),
    ).toThrow(HttpException);
  });

  it('sets X-RateLimit headers on admission', () => {
    enableQuota(5);
    const request = requestFor(DEV_A);

    guard.canActivate(contextFor(request) as never);

    expect(request.headersSet.get('X-RateLimit-Limit')).toBe('5');
    expect(request.headersSet.get('X-RateLimit-Remaining')).toBe('4');
  });

  it('sets Retry-After on denial', () => {
    enableQuota(1);
    const request = requestFor(DEV_A);
    guard.canActivate(contextFor(request) as never);

    expect(() => guard.canActivate(contextFor(request) as never)).toThrow();

    expect(request.headersSet.get('Retry-After')).toMatch(/^\d+$/);
    expect(request.headersSet.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('never leaks a developer id into the 429 response', () => {
    enableQuota(1);
    guard.canActivate(contextFor(requestFor(DEV_A)) as never);

    try {
      guard.canActivate(contextFor(requestFor(DEV_A)) as never);
      throw new Error('expected a 429');
    } catch (err) {
      const body = JSON.stringify((err as HttpException).getResponse());
      expect(body).not.toContain(DEV_A);
      expect(body).not.toContain('attacker-supplied');
    }
  });

  it('resolves through the Nest DI container', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        DeveloperQuotaGuard,
        RateLimitService,
        MetricsService,
        {
          provide: RATE_LIMIT_RECORD_STORE,
          useValue: { rateLimitRecord: { deleteMany: jest.fn() } },
        },
      ],
    }).compile();

    expect(module.get(DeveloperQuotaGuard)).toBeInstanceOf(DeveloperQuotaGuard);
    await module.close();
  });
});
