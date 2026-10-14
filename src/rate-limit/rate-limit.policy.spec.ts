import {
  MAX_DEFAULT_RATE_LIMIT_RPM,
  RATE_LIMIT_TIER_DEFAULTS,
  RATE_LIMIT_TIERS,
  RATE_LIMITED_ERROR_CODE,
  rateLimitPolicySnapshot,
  resolveRateLimitPolicy,
  resolveRateLimitTier,
} from './rate-limit.policy';

/**
 * Unit tests for the auth/payments rate-limit tier strategy (#926).
 *
 * Invariants under test:
 *  - credential endpoints are IP-keyed and tightly bounded;
 *  - money movement uses a stricter tier than general API traffic;
 *  - a malformed or negative config value falls back to the built-in default
 *    rather than disabling the limit;
 *  - a strict tier can be tightened but never loosened past `default`.
 */

describe('rate-limit policy (#926)', () => {
  describe('resolveRateLimitTier', () => {
    it.each([
      '/auth/login',
      '/auth/register',
      '/auth/verify',
      '/auth/refresh',
      '/auth/challenge',
      '/v1/auth/login',
      '/AUTH/LOGIN',
    ])('classifies credential endpoint %s as auth', (path) => {
      expect(resolveRateLimitTier(path)).toBe('auth');
    });

    it.each([
      '/v1/payments',
      '/v1/payments/',
      '/v1/payments/pay-123',
      '/payments?limit=1',
      '/v1/transactions',
      '/v1/transactions/internal/poll-pending',
    ])('classifies money path %s as payments', (path) => {
      expect(resolveRateLimitTier(path)).toBe('payments');
    });

    it.each([
      '/v1/wallets',
      '/health',
      '/metrics',
      '/v1/error-codes',
      '/some/new/route',
      '',
    ])('classifies %s as default (still rate limited)', (path) => {
      expect(resolveRateLimitTier(path)).toBe('default');
    });

    it('never classifies an unauthenticated route as unlimited', () => {
      // Adding a route must not silently escape rate limiting.
      for (const path of ['/brand-new', '/v1/brand-new', '/x/y/z']) {
        expect(resolveRateLimitTier(path)).toBe('default');
      }
    });
  });

  describe('resolveRateLimitPolicy — defaults', () => {
    it('applies built-in ceilings when nothing is configured', () => {
      const env: NodeJS.ProcessEnv = {};
      for (const tier of RATE_LIMIT_TIERS) {
        const policy = resolveRateLimitPolicy(tier, env);
        expect(policy.limit).toBe(RATE_LIMIT_TIER_DEFAULTS[tier].limit);
        expect(policy.windowMs).toBe(RATE_LIMIT_TIER_DEFAULTS[tier].windowMs);
      }
    });

    it('orders the tiers from strictest to most permissive', () => {
      const env: NodeJS.ProcessEnv = {};
      const auth = resolveRateLimitPolicy('auth', env);
      const payments = resolveRateLimitPolicy('payments', env);
      const fallback = resolveRateLimitPolicy('default', env);

      expect(auth.limit).toBeLessThan(payments.limit);
      expect(payments.limit).toBeLessThan(fallback.limit);
    });

    it('keys the auth tier by IP because no API key exists yet', () => {
      expect(resolveRateLimitPolicy('auth', {}).keyedByIp).toBe(true);
      expect(resolveRateLimitPolicy('payments', {}).keyedByIp).toBe(false);
    });
  });

  describe('resolveRateLimitPolicy — configuration', () => {
    it('honours explicit auth overrides', () => {
      const policy = resolveRateLimitPolicy('auth', {
        AUTH_RATE_LIMIT_MAX: '5',
        AUTH_RATE_LIMIT_WINDOW_MS: '30000',
      });

      expect(policy.limit).toBe(5);
      expect(policy.windowMs).toBe(30_000);
    });

    it('honours explicit payments overrides', () => {
      const policy = resolveRateLimitPolicy('payments', {
        PAYMENT_RATE_LIMIT_MAX: '25',
        PAYMENT_RATE_LIMIT_WINDOW_MS: '15000',
      });

      expect(policy.limit).toBe(25);
      expect(policy.windowMs).toBe(15_000);
    });

    it.each(['0', '-1', 'abc', '1.5', 'NaN', ''])(
      'falls back to the default for a malformed value %p',
      (value) => {
        const policy = resolveRateLimitPolicy('auth', {
          AUTH_RATE_LIMIT_MAX: value,
        });

        expect(policy.limit).toBe(RATE_LIMIT_TIER_DEFAULTS.auth.limit);
        expect(policy.limit).toBeGreaterThan(0);
      },
    );

    it('never lets a strict tier exceed the default ceiling', () => {
      // A typo that RAISES the money-path limit must not open the path.
      const policy = resolveRateLimitPolicy('payments', {
        PAYMENT_RATE_LIMIT_MAX: '100000',
      });

      expect(policy.limit).toBe(RATE_LIMIT_TIER_DEFAULTS.default.limit);
    });

    it('allows a strict tier to be tightened below the default', () => {
      const policy = resolveRateLimitPolicy('auth', {
        AUTH_RATE_LIMIT_MAX: '3',
      });

      expect(policy.limit).toBe(3);
    });

    it('ignores auth overrides on the payments tier and vice versa', () => {
      const policy = resolveRateLimitPolicy('payments', {
        AUTH_RATE_LIMIT_MAX: '1',
        PAYMENT_RATE_LIMIT_MAX: '42',
      });

      expect(policy.limit).toBe(42);
    });

    it('does not let a payments override move the default tier', () => {
      // Regression: `default` used to read PAYMENT_RATE_LIMIT_*, so loosening
      // the money path silently loosened every other route on the API.
      const raised = resolveRateLimitPolicy('default', {
        PAYMENT_RATE_LIMIT_MAX: '100000',
      });
      const auth = resolveRateLimitPolicy('auth', {
        PAYMENT_RATE_LIMIT_MAX: '100000',
      });
      const payments = resolveRateLimitPolicy('payments', {
        PAYMENT_RATE_LIMIT_MAX: '100000',
      });

      expect(raised.limit).toBe(RATE_LIMIT_TIER_DEFAULTS.default.limit);
      // The strict tiers keep their own (tighter) ceilings: a payments override
      // may not lift `auth` to 600, nor may it lift `payments` past the
      // default ceiling.
      expect(auth.limit).toBe(RATE_LIMIT_TIER_DEFAULTS.auth.limit);
      expect(payments.limit).toBe(RATE_LIMIT_TIER_DEFAULTS.default.limit);
    });

    it('does not let an auth override move the default tier', () => {
      const policy = resolveRateLimitPolicy('default', {
        AUTH_RATE_LIMIT_MAX: '99999',
      });
      expect(policy.limit).toBe(RATE_LIMIT_TIER_DEFAULTS.default.limit);
    });

    it('honours an explicit default override within the hard ceiling', () => {
      const policy = resolveRateLimitPolicy('default', {
        DEFAULT_RATE_LIMIT_MAX: '1200',
        DEFAULT_RATE_LIMIT_WINDOW_MS: '30000',
      });

      expect(policy.limit).toBe(1200);
      expect(policy.windowMs).toBe(30_000);
    });

    it('clamps the default override so it can never express "unlimited"', () => {
      const policy = resolveRateLimitPolicy('default', {
        DEFAULT_RATE_LIMIT_MAX: '1000000',
      });
      expect(policy.limit).toBe(MAX_DEFAULT_RATE_LIMIT_RPM);
    });

    it('clamps strict tiers to the *resolved* default ceiling, not the built-in', () => {
      // Lowering the ceiling must lower the tiers measured against it, and
      // raising it (within the hard ceiling) must let them follow it up.
      const tightened = resolveRateLimitPolicy('payments', {
        DEFAULT_RATE_LIMIT_MAX: '20',
        PAYMENT_RATE_LIMIT_MAX: '1000',
      });
      expect(tightened.limit).toBe(20);

      const raised = resolveRateLimitPolicy('payments', {
        DEFAULT_RATE_LIMIT_MAX: '900',
        PAYMENT_RATE_LIMIT_MAX: '1000',
      });
      expect(raised.limit).toBe(900);
    });

    it('never lets a strict tier exceed the hard default ceiling', () => {
      const policy = resolveRateLimitPolicy('auth', {
        DEFAULT_RATE_LIMIT_MAX: '1000000',
        AUTH_RATE_LIMIT_MAX: '1000000',
      });
      expect(policy.limit).toBe(MAX_DEFAULT_RATE_LIMIT_RPM);
    });
  });

  describe('rateLimitPolicySnapshot', () => {
    it('exposes one limit per tier for metrics', () => {
      const snapshot = rateLimitPolicySnapshot({});

      for (const tier of RATE_LIMIT_TIERS) {
        expect(snapshot[`rateLimitTier_${tier}_limit`]).toBeGreaterThan(0);
      }
    });

    it('contains no secret material', () => {
      const snapshot = rateLimitPolicySnapshot({
        CRON_SECRET: 'super-secret-value',
        WALLET_ENCRYPTION_KEY: 'k'.repeat(32),
      });

      expect(JSON.stringify(snapshot)).not.toContain('super-secret-value');
      expect(JSON.stringify(snapshot)).not.toContain('kkkk');
    });
  });

  it('exposes a stable, client-branchable error code', () => {
    expect(RATE_LIMITED_ERROR_CODE).toBe('RATE_LIMITED');
  });
});
