import {
  DEFAULT_MAX_SPONSORED_WALLETS_GLOBAL,
  DEFAULT_MAX_SPONSORED_WALLETS_PER_USER,
  DEFAULT_SPONSORSHIP_WINDOW_MS,
  resolveSponsorshipLimits,
  WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV,
  WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV,
  WALLET_SPONSORSHIP_ENABLED_ENV,
  WALLET_SPONSORSHIP_WINDOW_MS_ENV,
  WalletSponsorshipLimitErrorCode,
  WalletSponsorshipLimiter,
} from './wallet-sponsorship-limits';
import type { WalletSponsorshipLimits } from './wallet-sponsorship-limits';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

/** Limiter over a fixed clock, so window rollover is deterministic. */
function limiterWith(limits: WalletSponsorshipLimits, start = 1_000) {
  let now = start;
  return {
    limiter: new WalletSponsorshipLimiter(limits, () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const LIMITS = {
  enabled: true,
  maxPerUser: 2,
  maxGlobal: 3,
  windowMs: 1_000,
};

describe('resolveSponsorshipLimits', () => {
  describe('fail-closed defaults', () => {
    it('enables sponsorship with default caps when nothing is set', () => {
      // The failure mode of a missing variable must be "default caps", never
      // "no caps" — an unconfigured deploy still has to be protected.
      expect(resolveSponsorshipLimits({})).toEqual({
        enabled: true,
        maxPerUser: DEFAULT_MAX_SPONSORED_WALLETS_PER_USER,
        maxGlobal: DEFAULT_MAX_SPONSORED_WALLETS_GLOBAL,
        windowMs: DEFAULT_SPONSORSHIP_WINDOW_MS,
      });
    });

    it.each(['abc', '0', '-1', '', ' '])(
      'never widens the per-user cap for the unusable value %p',
      (raw) => {
        const limits = resolveSponsorshipLimits({
          [WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV]: raw,
        });

        expect(limits.maxPerUser).toBe(DEFAULT_MAX_SPONSORED_WALLETS_PER_USER);
      },
    );

    it.each(['abc', '0', '-5'])(
      'never widens the global cap for the unusable value %p',
      (raw) => {
        expect(
          resolveSponsorshipLimits({
            [WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV]: raw,
          }).maxGlobal,
        ).toBe(DEFAULT_MAX_SPONSORED_WALLETS_GLOBAL);
      },
    );

    it('falls back to the default window for an unusable value', () => {
      expect(
        resolveSponsorshipLimits({ [WALLET_SPONSORSHIP_WINDOW_MS_ENV]: 'soon' })
          .windowMs,
      ).toBe(DEFAULT_SPONSORSHIP_WINDOW_MS);
    });
  });

  describe('valid overrides', () => {
    it('honours explicit caps', () => {
      const limits = resolveSponsorshipLimits({
        [WALLET_MAX_SPONSORED_WALLETS_PER_USER_ENV]: '7',
        [WALLET_MAX_SPONSORED_WALLETS_GLOBAL_ENV]: '70',
        [WALLET_SPONSORSHIP_WINDOW_MS_ENV]: '60000',
      });

      expect(limits).toMatchObject({
        maxPerUser: 7,
        maxGlobal: 70,
        windowMs: 60_000,
      });
    });

    it('is enabled by default even with no explicit flag', () => {
      expect(resolveSponsorshipLimits({}).enabled).toBe(true);
    });

    it.each(['false', 'FALSE', '0', 'off', 'no'])(
      'treats %p as the kill-switch',
      (raw) => {
        expect(
          resolveSponsorshipLimits({ [WALLET_SPONSORSHIP_ENABLED_ENV]: raw })
            .enabled,
        ).toBe(false);
      },
    );

    it.each(['true', '1', 'on', 'yes'])('treats %p as enabled', (raw) => {
      expect(
        resolveSponsorshipLimits({ [WALLET_SPONSORSHIP_ENABLED_ENV]: raw })
          .enabled,
      ).toBe(true);
    });
  });
});

describe('WalletSponsorshipLimiter', () => {
  describe('per-user cap', () => {
    it('admits requests up to the cap', () => {
      const { limiter } = limiterWith(LIMITS);

      expect(limiter.assertWithinLimits('user-1').allowed).toBe(true);
      expect(limiter.assertWithinLimits('user-1').allowed).toBe(true);
    });

    it('refuses the request past the cap with a stable code', () => {
      const { limiter } = limiterWith(LIMITS);
      limiter.assertWithinLimits('user-1');
      limiter.assertWithinLimits('user-1');

      expect(codeOf(() => limiter.assertWithinLimits('user-1'))).toBe(
        WalletSponsorshipLimitErrorCode.PER_USER_LIMIT_REACHED,
      );
    });

    it('does not let one user consume another user’s allowance', () => {
      const { limiter } = limiterWith(LIMITS);
      limiter.assertWithinLimits('user-1');
      limiter.assertWithinLimits('user-1');

      // user-1 is exhausted, but user-2 is untouched.
      expect(limiter.assertWithinLimits('user-2').allowed).toBe(true);
    });

    it('does not consume budget when it refuses', () => {
      const { limiter } = limiterWith({ ...LIMITS, maxPerUser: 1 });
      limiter.assertWithinLimits('user-1');

      expect(codeOf(() => limiter.assertWithinLimits('user-1'))).toBeDefined();
      expect(limiter.currentUsage().total).toBe(1);
    });
  });

  describe('global cap', () => {
    it('refuses once the deployment-wide cap is reached', () => {
      // maxPerUser 2, maxGlobal 3: two users exhaust the deployment budget.
      const { limiter } = limiterWith(LIMITS);
      limiter.assertWithinLimits('user-1');
      limiter.assertWithinLimits('user-1');
      limiter.assertWithinLimits('user-2');

      expect(codeOf(() => limiter.assertWithinLimits('user-3'))).toBe(
        WalletSponsorshipLimitErrorCode.GLOBAL_LIMIT_REACHED,
      );
    });

    it('reports the per-user cap first when both are exhausted', () => {
      const { limiter } = limiterWith({
        ...LIMITS,
        maxPerUser: 1,
        maxGlobal: 1,
      });
      limiter.assertWithinLimits('user-1');

      // Same user, so the per-user code is the more actionable one.
      expect(codeOf(() => limiter.assertWithinLimits('user-1'))).toBe(
        WalletSponsorshipLimitErrorCode.PER_USER_LIMIT_REACHED,
      );
    });
  });

  describe('kill-switch', () => {
    it('refuses every request when sponsorship is disabled', () => {
      const { limiter } = limiterWith({ ...LIMITS, enabled: false });

      expect(codeOf(() => limiter.assertWithinLimits('user-1'))).toBe(
        WalletSponsorshipLimitErrorCode.SPONSORSHIP_DISABLED,
      );
    });

    it('has no value that removes the caps while still sponsoring', () => {
      // Disabling the kill-switch must restore the caps, not bypass them.
      const limits = resolveSponsorshipLimits({
        [WALLET_SPONSORSHIP_ENABLED_ENV]: 'true',
      });
      const { limiter } = limiterWith({ ...limits, maxPerUser: 1 });
      limiter.assertWithinLimits('user-1');

      expect(codeOf(() => limiter.assertWithinLimits('user-1'))).toBe(
        WalletSponsorshipLimitErrorCode.PER_USER_LIMIT_REACHED,
      );
    });
  });

  describe('adversarial input', () => {
    it('refuses rather than throwing an unattributable error', () => {
      const { limiter } = limiterWith(LIMITS);

      for (const bad of ['', '   ', undefined, null, 42]) {
        expect(codeOf(() => limiter.assertWithinLimits(bad as string))).toBe(
          WalletSponsorshipLimitErrorCode.DEPENDENCY_UNAVAILABLE,
        );
      }
    });

    it('does not consume budget for a rejected caller', () => {
      const { limiter } = limiterWith(LIMITS);

      // A caller that cannot be attributed is refused, not counted.
      codeOf(() => limiter.assertWithinLimits(42 as unknown as string));

      expect(limiter.currentUsage().total).toBe(0);
    });
  });

  describe('window rollover', () => {
    it('resets usage once the window elapses', () => {
      // A long outage must not permanently block wallet creation.
      const { limiter, advance } = limiterWith(LIMITS);
      limiter.assertWithinLimits('user-1');
      limiter.assertWithinLimits('user-1');
      expect(codeOf(() => limiter.assertWithinLimits('user-1'))).toBeDefined();

      advance(LIMITS.windowMs);

      expect(limiter.assertWithinLimits('user-1').allowed).toBe(true);
    });

    it('does not roll the window early', () => {
      const { limiter, advance } = limiterWith(LIMITS);
      limiter.assertWithinLimits('user-1');
      limiter.assertWithinLimits('user-1');

      advance(LIMITS.windowMs - 1);

      expect(codeOf(() => limiter.assertWithinLimits('user-1'))).toBe(
        WalletSponsorshipLimitErrorCode.PER_USER_LIMIT_REACHED,
      );
    });
  });

  it('reports usage without exposing anything sensitive', () => {
    const { limiter } = limiterWith(LIMITS);
    limiter.assertWithinLimits('user-1');

    const usage = limiter.currentUsage();
    // Counts and a timestamp only — no keys, seeds, or addresses.
    expect(Object.keys(usage).sort()).toEqual([
      'perUser',
      'total',
      'windowStartedAt',
    ]);
    expect(usage.total).toBe(1);
  });

  it('can be reset for an operator-driven flush', () => {
    const { limiter } = limiterWith(LIMITS);
    limiter.assertWithinLimits('user-1');
    limiter.assertWithinLimits('user-1');

    limiter.reset();

    expect(limiter.assertWithinLimits('user-1').allowed).toBe(true);
  });
});
