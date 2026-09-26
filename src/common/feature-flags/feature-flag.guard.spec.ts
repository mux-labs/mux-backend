import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  FeatureFlag,
  FeatureFlagErrorCode,
  FeatureFlagGuard,
  FEATURE_FLAGS_KILL_SWITCH_ENV,
  resolveFeatureFlag,
} from './feature-flag.guard';

const FLAG = 'wallet_orchestrator';
const ENV_KEY = 'FEATURE_WALLET_ORCHESTRATOR';

class TestController {
  @FeatureFlag(FLAG)
  handle(): string {
    return 'ok';
  }
}

/** ExecutionContext wired to the `@FeatureFlag`-decorated handler. */
function context(xRequestId = 'req-flag-1'): ExecutionContext {
  return {
    getHandler: () => TestController.prototype.handle,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({ headers: { 'x-request-id': xRequestId } }),
    }),
  } as unknown as ExecutionContext;
}

/** Sets the flag, runs `fn`, then restores the previous environment. */
function withFlag(
  value: string | undefined,
  killSwitch: string | undefined,
  fn: () => void,
) {
  const previous = process.env[ENV_KEY];
  const previousKill = process.env[FEATURE_FLAGS_KILL_SWITCH_ENV];

  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;

  if (killSwitch === undefined)
    delete process.env[FEATURE_FLAGS_KILL_SWITCH_ENV];
  else process.env[FEATURE_FLAGS_KILL_SWITCH_ENV] = killSwitch;

  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    if (previousKill === undefined)
      delete process.env[FEATURE_FLAGS_KILL_SWITCH_ENV];
    else process.env[FEATURE_FLAGS_KILL_SWITCH_ENV] = previousKill;
  }
}

describe('resolveFeatureFlag — default-safe in production (#944)', () => {
  const env = (flag?: string): NodeJS.ProcessEnv => ({
    ...(flag === undefined ? {} : { [ENV_KEY]: flag }),
  });

  it('denies by default when the flag is unset', () => {
    const decision = resolveFeatureFlag(FLAG, env());

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('unset');
    expect(decision.envKey).toBe(ENV_KEY);
    expect(decision.denialCode).toBe(FeatureFlagErrorCode.DISABLED);
  });

  it('enables only on the literal "true"', () => {
    expect(resolveFeatureFlag(FLAG, env('true')).enabled).toBe(true);
    expect(resolveFeatureFlag(FLAG, env(' TRUE ')).enabled).toBe(true);
  });

  it.each(['false', 'FALSE', '0', '1', 'yes', 'on', 'true '])(
    'stays disabled for %j rather than failing open',
    (value) => {
      // Only the exact literal enables a money path; every other spelling
      // (including a stray space or a numeric 1) must be refused.
      expect(resolveFeatureFlag(FLAG, env(value)).enabled).toBe(
        value.trim().toLowerCase() === 'true',
      );
    },
  );

  it('reports a truthy-but-not-"true" value as a misconfiguration', () => {
    expect(resolveFeatureFlag(FLAG, env('1')).reason).toBe('non_boolean_value');
  });

  it('resolves identically for production and development', () => {
    const prod = resolveFeatureFlag(FLAG, { ...env(), NODE_ENV: 'production' });
    const dev = resolveFeatureFlag(FLAG, { ...env(), NODE_ENV: 'development' });

    expect(prod).toEqual(dev);
    expect(prod.enabled).toBe(false);
  });

  it('the global kill-switch beats an explicitly enabled flag', () => {
    const decision = resolveFeatureFlag(FLAG, {
      ...env('true'),
      [FEATURE_FLAGS_KILL_SWITCH_ENV]: 'true',
    });

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('kill_switch');
    expect(decision.denialCode).toBe(FeatureFlagErrorCode.KILL_SWITCH_ENGAGED);
  });

  it('emits an ops-safe decision snapshot with no extra fields', () => {
    expect(Object.keys(resolveFeatureFlag(FLAG, {})).sort()).toEqual([
      'denialCode',
      'enabled',
      'envKey',
      'reason',
    ]);
  });
});

describe('FeatureFlagGuard', () => {
  const guard = new FeatureFlagGuard(new Reflector());

  it('allows the route when the flag is explicitly enabled', () => {
    withFlag('true', undefined, () => {
      expect(guard.canActivate(context())).toBe(true);
    });
  });

  it('denies with 403, a stable code and the correlation id', () => {
    withFlag('false', undefined, () => {
      try {
        guard.canActivate(context('req-flag-42'));
        throw new Error('expected the guard to deny');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        const body = (error as ForbiddenException).getResponse() as any;
        expect(body.code).toBe(FeatureFlagErrorCode.DISABLED);
        expect(body.message).toMatch(/Feature is not available/i);
        expect(body.message).toContain(ENV_KEY);
        expect(body.correlationId).toBe('req-flag-42');
      }
    });
  });

  it('denies when the flag is absent (a fresh production deploy)', () => {
    withFlag(undefined, undefined, () => {
      expect(() => guard.canActivate(context())).toThrow(ForbiddenException);
    });
  });

  it('denies every gated surface when the kill-switch is engaged', () => {
    withFlag('true', '1', () => {
      expect(() => guard.canActivate(context())).toThrow(ForbiddenException);
    });
  });
});
