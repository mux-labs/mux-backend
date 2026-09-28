import { ExecutionContext, HttpException } from '@nestjs/common';
import { MAX_TRACKED_SUBJECTS, RateLimitGuard } from './rate-limit.guard';
import {
  RATE_LIMITED_ERROR_CODE,
  resolveRateLimitPolicy,
} from './rate-limit.policy';

/**
 * Unit tests for the tier-enforcing global rate-limit guard (#926).
 *
 * The policy module is unit-tested separately; these tests prove the guard
 * actually *applies* it — that is, that the documented tiers are enforced on
 * the live request path rather than merely described.
 *
 * Invariants under test:
 *  - the auth tier is IP-keyed, so one host's bursts cannot exhaust another's
 *    budget, and two anonymous callers never share a single counter;
 *  - refusals are `429` + `RATE_LIMITED` + the tier name, with `Retry-After`
 *    and `X-RateLimit-*` headers;
 *  - the money path is bounded more tightly than general traffic;
 *  - no credential material is used as a key or echoed in a response;
 *  - the tracked-subject map is bounded.
 */

/** Shape of the body a refusal carries. */
interface RefusalBody {
  errorCode: string;
  tier: string;
  retryAfterSeconds: number;
}

function contextFor(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function request(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    method: 'GET',
    originalUrl: '/v1/wallets',
    ip: '10.0.0.1',
    ...overrides,
  };
}

/** Drive `count` requests through the guard, collecting the headers set. */
function drive(
  guard: RateLimitGuard,
  count: number,
  makeRequest: () => Record<string, unknown>,
): { headers: Record<string, string>; refusedAt?: number } {
  const headers: Record<string, string> = {};
  let refusedAt: number | undefined;

  for (let i = 0; i < count; i++) {
    const req = makeRequest();
    req.set = (name: string, value: string) => {
      headers[name] = value;
    };
    try {
      guard.canActivate(contextFor(req));
    } catch (error) {
      if (i === count - 1) {
        refusedAt = i + 1;
      }
      expect(error).toBeInstanceOf(HttpException);
    }
  }

  return { headers, refusedAt };
}

/** Run `count` requests through one request object, returning the last throw. */
function exhaust(
  guard: RateLimitGuard,
  req: Record<string, unknown>,
  count: number,
): unknown {
  let thrown: unknown;
  for (let i = 0; i < count; i++) {
    try {
      guard.canActivate(contextFor(req));
    } catch (error) {
      thrown = error;
    }
  }
  return thrown;
}

const authLimit = resolveRateLimitPolicy('auth').limit;
const paymentsLimit = resolveRateLimitPolicy('payments').limit;
const defaultLimit = resolveRateLimitPolicy('default').limit;

describe('RateLimitGuard (#926)', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  describe('tier selection', () => {
    it('applies the tight auth ceiling to the credential surface', () => {
      const guard = new RateLimitGuard();

      const { refusedAt } = drive(guard, authLimit + 1, () =>
        request({ originalUrl: '/v1/auth/login' }),
      );

      expect(refusedAt).toBe(authLimit + 1);
    });

    it('applies a tighter ceiling to the money path than to general traffic', () => {
      const guard = new RateLimitGuard();

      const { refusedAt } = drive(guard, paymentsLimit + 1, () =>
        request({ originalUrl: '/v1/payments', apiKey: { id: 'key-1' } }),
      );

      expect(refusedAt).toBe(paymentsLimit + 1);
      expect(paymentsLimit).toBeLessThan(defaultLimit);
    });

    it('never leaves an unrecognised route unthrottled', () => {
      const guard = new RateLimitGuard();

      const { refusedAt } = drive(guard, defaultLimit + 1, () =>
        request({ originalUrl: '/v1/some/brand/new/route' }),
      );

      expect(refusedAt).toBe(defaultLimit + 1);
    });

    it('normalizes a trailing slash and a query string', () => {
      const guard = new RateLimitGuard();

      const { refusedAt } = drive(guard, authLimit + 1, () =>
        request({ originalUrl: '/v1/auth/login/?next=%2Fwallets' }),
      );

      expect(refusedAt).toBe(authLimit + 1);
    });
  });

  describe('keying', () => {
    it('gives two anonymous callers from different hosts separate budgets', () => {
      const guard = new RateLimitGuard();

      // Exhaust host A on the auth tier.
      const a = drive(guard, authLimit + 1, () =>
        request({ originalUrl: '/v1/auth/login', ip: '10.0.0.1' }),
      );
      expect(a.refusedAt).toBe(authLimit + 1);

      // Host B must be unaffected: the previous implementation funnelled every
      // caller without an Authorization header into one 'anonymous' counter, so
      // one host could lock out every other anonymous caller.
      const b = drive(guard, authLimit, () =>
        request({ originalUrl: '/v1/auth/login', ip: '10.0.0.2' }),
      );
      expect(b.refusedAt).toBeUndefined();
    });

    it('gives two API keys separate budgets on the money path', () => {
      const guard = new RateLimitGuard();
      const make = (id: string) => () =>
        request({ originalUrl: '/v1/payments', apiKey: { id } });

      expect(
        drive(guard, paymentsLimit, make('key-1')).refusedAt,
      ).toBeUndefined();
      expect(
        drive(guard, paymentsLimit, make('key-2')).refusedAt,
      ).toBeUndefined();
    });

    it('does not key on the presented credential', () => {
      const guard = new RateLimitGuard();

      // A request with a bearer token but no resolved key id falls back to the
      // client address rather than to a shared constant bucket.
      const { refusedAt } = drive(guard, defaultLimit + 1, () =>
        request({
          originalUrl: '/v1/wallets',
          headers: { authorization: 'Bearer a-completely-different-token' },
        }),
      );

      expect(refusedAt).toBe(defaultLimit + 1);
    });

    it('falls back to the socket address when express reports no ip', () => {
      const guard = new RateLimitGuard();

      const { refusedAt } = drive(guard, authLimit + 1, () =>
        request({
          originalUrl: '/v1/auth/login',
          ip: undefined,
          socket: { remoteAddress: '198.51.100.7' },
        }),
      );

      expect(refusedAt).toBe(authLimit + 1);
    });
  });

  describe('refusal contract', () => {
    it('answers 429 with the stable RATE_LIMITED code and the tier name', () => {
      const guard = new RateLimitGuard();
      const req = request({
        originalUrl: '/v1/payments',
        apiKey: { id: 'key-1' },
        set: () => undefined,
      });

      const thrown = exhaust(guard, req, paymentsLimit + 1);

      expect(thrown).toBeInstanceOf(HttpException);
      const http = thrown as HttpException;
      expect(http.getStatus()).toBe(429);

      const body = http.getResponse() as RefusalBody;
      expect(body.errorCode).toBe(RATE_LIMITED_ERROR_CODE);
      expect(body.tier).toBe('payments');
      expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    it('sets Retry-After and the X-RateLimit-* headers on a refusal', () => {
      const guard = new RateLimitGuard();

      const { refusedAt, headers } = drive(guard, authLimit + 1, () =>
        request({ originalUrl: '/v1/auth/login' }),
      );

      expect(refusedAt).toBe(authLimit + 1);
      expect(headers['Retry-After']).toMatch(/^\d+$/);
      expect(headers['X-RateLimit-Limit']).toBe(String(authLimit));
      expect(headers['X-RateLimit-Remaining']).toBe('0');
      expect(headers['X-RateLimit-Reset']).toMatch(/^\d+$/);
    });

    it('reports remaining budget on admitted requests', () => {
      const guard = new RateLimitGuard();

      const { headers } = drive(guard, 1, () =>
        request({ originalUrl: '/v1/wallets', apiKey: { id: 'key-1' } }),
      );

      expect(headers['X-RateLimit-Limit']).toBe(String(defaultLimit));
      expect(headers['X-RateLimit-Remaining']).toBe(String(defaultLimit - 1));
    });

    it('never echoes the subject key or a credential in the refusal', () => {
      const guard = new RateLimitGuard();
      const req = request({
        originalUrl: '/v1/payments',
        apiKey: { id: 'super-secret-key-id' },
        set: () => undefined,
      });

      const thrown = exhaust(guard, req, paymentsLimit + 1);

      expect(
        JSON.stringify((thrown as HttpException).getResponse()),
      ).not.toContain('super-secret-key-id');
    });
  });

  describe('configuration', () => {
    it('honours a tightened auth limit from the environment', () => {
      process.env.AUTH_RATE_LIMIT_MAX = '2';
      const guard = new RateLimitGuard();

      const { refusedAt } = drive(guard, 3, () =>
        request({ originalUrl: '/v1/auth/login' }),
      );

      expect(refusedAt).toBe(3);
    });

    it('falls back to the built-in default for a malformed limit', () => {
      process.env.AUTH_RATE_LIMIT_MAX = 'not-a-number';
      const guard = new RateLimitGuard();

      // A malformed value must not disable the tier.
      const { refusedAt } = drive(guard, authLimit + 1, () =>
        request({ originalUrl: '/v1/auth/login' }),
      );

      expect(refusedAt).toBe(authLimit + 1);
    });

    it('does not let a strict tier be raised above the default ceiling', () => {
      process.env.PAYMENT_RATE_LIMIT_MAX = '100000';
      const guard = new RateLimitGuard();

      const { refusedAt } = drive(guard, defaultLimit + 1, () =>
        request({ originalUrl: '/v1/payments', apiKey: { id: 'key-1' } }),
      );

      expect(refusedAt).toBe(defaultLimit + 1);
    });
  });

  describe('bounded memory', () => {
    it(`keeps at most ${MAX_TRACKED_SUBJECTS} tracked subjects per tier`, () => {
      process.env.AUTH_RATE_LIMIT_MAX = '1';
      const guard = new RateLimitGuard();

      // One request each from far more distinct hosts than the cap. The guard
      // must evict rather than grow without bound.
      for (let i = 0; i < MAX_TRACKED_SUBJECTS + 500; i++) {
        const req = request({
          originalUrl: '/v1/auth/login',
          ip: `10.1.${Math.floor(i / 256)}.${i % 256}`,
          set: () => undefined,
        });
        try {
          guard.canActivate(contextFor(req));
        } catch {
          // Refusals are fine; the point is that memory stays bounded.
        }
      }

      const tracked = (
        guard as unknown as { windows: Map<string, Map<string, unknown>> }
      ).windows.get('auth');
      expect(tracked!.size).toBeLessThanOrEqual(MAX_TRACKED_SUBJECTS);
    });
  });
});
