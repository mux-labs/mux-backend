import {
  ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { MaintenanceAdminGuard } from './maintenance-admin.guard';
import {
  MAINTENANCE_ADMIN_SECRET_ENV,
  MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV,
  MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV,
  MAINTENANCE_SECRET_RESULT,
  MAINTENANCE_UNAUTHORIZED_ERROR_CODE,
  MaintenanceSecretService,
} from './maintenance-secret.service';

/**
 * Unit tests for the maintenance admin guard (#925).
 *
 * This guard is the *only* consumer of the maintenance admin secret, so these
 * tests are what prove the documented rotation procedure works end-to-end
 * rather than only inside the service.
 *
 * Invariants under test:
 *  - deny-by-default: an unconfigured secret authorizes nobody;
 *  - the current secret authorizes; a wrong or absent value does not;
 *  - a previous secret authorizes only inside its overlap window;
 *  - every refusal is the same 401 + stable code, so the response cannot be
 *    used to probe which part of a guess was right;
 *  - a previous-secret authorization is logged, so an unfinished rotation is
 *    observable.
 */

const CURRENT = 'current-maintenance-secret-value';
const PREVIOUS = 'previous-maintenance-secret-value';
const NOW = new Date('2026-09-28T12:00:00.000Z');

const futureIso = (minutes: number): string =>
  new Date(NOW.getTime() + minutes * 60_000).toISOString();

const pastIso = (minutes: number): string =>
  new Date(NOW.getTime() - minutes * 60_000).toISOString();

function context(headers?: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, requestId: 'req-123' }),
    }),
  } as unknown as ExecutionContext;
}

function guardFor(
  env: NodeJS.ProcessEnv,
  now: Date = NOW,
): MaintenanceAdminGuard {
  jest.useFakeTimers().setSystemTime(now);
  return new MaintenanceAdminGuard(new MaintenanceSecretService(env));
}

/** Invoke the guard and return the refusal it threw. */
function refuse(
  instance: MaintenanceAdminGuard,
  headers?: Record<string, unknown>,
): UnauthorizedException {
  try {
    instance.canActivate(context(headers));
  } catch (error) {
    return error as UnauthorizedException;
  }
  throw new Error('expected the guard to refuse the request');
}

/**
 * The guard's logger is a per-instance `Logger`, so the assertions below spy on
 * `Logger.prototype` rather than reaching into the guard's private field.
 */
const nestLoggerSpy = (level: 'warn' | 'error') =>
  jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('MaintenanceAdminGuard (#925)', () => {
  describe('authorization', () => {
    it('authorizes the current secret', () => {
      const guard = guardFor({ [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT });

      expect(
        guard.canActivate(context({ 'x-maintenance-secret': CURRENT })),
      ).toBe(true);
    });

    it.each([
      ['a wrong secret', 'not-the-secret'],
      ['an empty header', ''],
      ['a blank header', '   '],
    ])('rejects %s', (_label, presented) => {
      const guard = guardFor({ [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT });

      expect(() =>
        guard.canActivate(context({ 'x-maintenance-secret': presented })),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a request carrying no header at all', () => {
      const guard = guardFor({ [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT });

      expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    });

    it('authorizes nobody when no secret is configured (deny-by-default)', () => {
      const guard = guardFor({});

      expect(() =>
        guard.canActivate(context({ 'x-maintenance-secret': 'anything' })),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('rotation window', () => {
    const rotating = {
      [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
      [MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV]: PREVIOUS,
      [MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV]: futureIso(60),
    };

    it('authorizes the previous secret inside the window', () => {
      const guard = guardFor(rotating);

      expect(
        guard.canActivate(context({ 'x-maintenance-secret': PREVIOUS })),
      ).toBe(true);
    });

    it('still authorizes the current secret inside the window', () => {
      const guard = guardFor(rotating);

      expect(
        guard.canActivate(context({ 'x-maintenance-secret': CURRENT })),
      ).toBe(true);
    });

    it('rejects the previous secret once the window has closed', () => {
      const guard = guardFor({
        ...rotating,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV]: pastIso(1),
      });

      expect(() =>
        guard.canActivate(context({ 'x-maintenance-secret': PREVIOUS })),
      ).toThrow(UnauthorizedException);
    });

    it('rejects the previous secret when no expiry is configured', () => {
      const guard = guardFor({
        [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV]: PREVIOUS,
      });

      expect(() =>
        guard.canActivate(context({ 'x-maintenance-secret': PREVIOUS })),
      ).toThrow(UnauthorizedException);
    });

    it('rejects the previous secret when the expiry is unparseable', () => {
      const guard = guardFor({
        ...rotating,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV]: 'not-a-date',
      });

      expect(() =>
        guard.canActivate(context({ 'x-maintenance-secret': PREVIOUS })),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('refusal contract', () => {
    it.each([
      [
        'a mismatch',
        { [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT },
        'wrong',
      ] as const,
      [
        'a missing header',
        { [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT },
        undefined,
      ] as const,
      ['an unconfigured secret', {}, 'anything'] as const,
    ])(
      'returns the same 401 and stable code on %s',
      (_label, env, presented) => {
        const error = refuse(
          guardFor(env),
          presented === undefined
            ? undefined
            : { 'x-maintenance-secret': presented },
        );

        expect(error).toBeInstanceOf(UnauthorizedException);
        expect((error.getResponse() as { errorCode?: string }).errorCode).toBe(
          MAINTENANCE_UNAUTHORIZED_ERROR_CODE,
        );
      },
    );

    it('never leaks the configured or presented secret in the response', () => {
      const error = refuse(
        guardFor({ [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT }),
        { 'x-maintenance-secret': 'guessed-value' },
      );

      const serialized = JSON.stringify(error.getResponse());
      expect(serialized).not.toContain(CURRENT);
      expect(serialized).not.toContain('guessed-value');
    });
  });

  describe('observability', () => {
    it('reports a previous-secret authorization as a rotation in progress', () => {
      const warn = nestLoggerSpy('warn');

      guardFor({
        [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV]: PREVIOUS,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV]: futureIso(60),
      }).canActivate(context({ 'x-maintenance-secret': PREVIOUS }));

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('rotation in progress'),
      );
    });

    it('does not report a rotation when the current secret is used', () => {
      const warn = nestLoggerSpy('warn');

      guardFor({ [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT }).canActivate(
        context({ 'x-maintenance-secret': CURRENT }),
      );

      expect(warn).not.toHaveBeenCalled();
    });

    it('logs the stable reason code, never the secret', () => {
      const warn = nestLoggerSpy('warn');

      refuse(guardFor({ [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT }), {
        'x-maintenance-secret': 'guessed-value',
      });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(MAINTENANCE_SECRET_RESULT.MISMATCH),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(CURRENT));
    });
  });
});
