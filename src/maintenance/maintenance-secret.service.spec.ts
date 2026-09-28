import {
  MAINTENANCE_ADMIN_SECRET_ENV,
  MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV,
  MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV,
  MAINTENANCE_SECRET_RESULT,
  MaintenanceSecretService,
  secretsMatch,
} from './maintenance-secret.service';

/**
 * Unit tests for maintenance admin secret verification and rotation (#925).
 *
 * Invariants under test:
 *  - deny-by-default: an unconfigured secret authorizes nobody;
 *  - the current secret authorizes; a wrong or absent value does not;
 *  - a previous secret is accepted ONLY inside its overlap window;
 *  - an unparseable or absent expiry closes the window (fail-closed);
 *  - the rotation snapshot never contains secret material.
 */

const CURRENT = 'current-maintenance-secret-value';
const PREVIOUS = 'previous-maintenance-secret-value';
const NOW = new Date('2026-09-28T12:00:00.000Z');

function futureIso(from: Date, minutes: number): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

function pastIso(from: Date, minutes: number): string {
  return new Date(from.getTime() - minutes * 60_000).toISOString();
}

const request = (headers?: Record<string, unknown>) => ({ headers });

describe('MaintenanceSecretService (#925)', () => {
  describe('deny-by-default', () => {
    it('authorizes nobody when no secret is configured', () => {
      const service = new MaintenanceSecretService({});

      const outcome = service.verify(
        request({ 'x-maintenance-secret': 'anything' }),
        NOW,
      );

      expect(outcome.authorized).toBe(false);
      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.NOT_CONFIGURED);
    });

    it('authorizes nobody when the configured secret is empty', () => {
      const service = new MaintenanceSecretService({
        [MAINTENANCE_ADMIN_SECRET_ENV]: '',
      });

      expect(
        service.verify(request({ 'x-maintenance-secret': '' })).authorized,
      ).toBe(false);
    });

    it('rejects a missing header as MISSING, not MISMATCH', () => {
      const service = new MaintenanceSecretService({
        [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
      });

      const outcome = service.verify(request(), NOW);

      expect(outcome.authorized).toBe(false);
      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.MISSING);
    });

    it('rejects a blank header as MISSING', () => {
      const service = new MaintenanceSecretService({
        [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
      });

      const outcome = service.verify(
        request({ 'x-maintenance-secret': '   ' }),
        NOW,
      );

      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.MISSING);
    });
  });

  describe('current secret', () => {
    const service = new MaintenanceSecretService({
      [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
    });

    it('authorizes the exact current secret', () => {
      const outcome = service.verify(
        request({ 'x-maintenance-secret': CURRENT }),
        NOW,
      );

      expect(outcome.authorized).toBe(true);
      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.OK);
      expect(outcome.usedPreviousSecret).toBe(false);
    });

    it('tolerates surrounding whitespace from a copy/paste', () => {
      const outcome = service.verify(
        request({ 'x-maintenance-secret': `  ${CURRENT}  ` }),
        NOW,
      );

      expect(outcome.authorized).toBe(true);
    });

    it('accepts an explicitly-cased header key', () => {
      const outcome = service.verify(
        request({ 'X-Maintenance-Secret': CURRENT }),
        NOW,
      );

      expect(outcome.authorized).toBe(true);
    });

    it('rejects a wrong secret', () => {
      const outcome = service.verify(
        request({ 'x-maintenance-secret': 'wrong' }),
        NOW,
      );

      expect(outcome.authorized).toBe(false);
      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.MISMATCH);
    });

    it('rejects a prefix of the secret (no partial match)', () => {
      const outcome = service.verify(
        request({ 'x-maintenance-secret': CURRENT.slice(0, -1) }),
        NOW,
      );

      expect(outcome.authorized).toBe(false);
    });
  });

  describe('rotation overlap window', () => {
    const rotatingEnv = (expiresAt?: string): NodeJS.ProcessEnv => ({
      [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
      [MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV]: PREVIOUS,
      ...(expiresAt
        ? {
            [MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV]: expiresAt,
          }
        : {}),
    });

    it('accepts the previous secret while the window is open', () => {
      const service = new MaintenanceSecretService(
        rotatingEnv(futureIso(NOW, 30)),
      );

      const outcome = service.verify(
        request({ 'x-maintenance-secret': PREVIOUS }),
        NOW,
      );

      expect(outcome.authorized).toBe(true);
      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.OK_PREVIOUS);
      // Flagged so an operator can alert on an unfinished rotation.
      expect(outcome.usedPreviousSecret).toBe(true);
    });

    it('still accepts the current secret during the overlap window', () => {
      const service = new MaintenanceSecretService(
        rotatingEnv(futureIso(NOW, 30)),
      );

      const outcome = service.verify(
        request({ 'x-maintenance-secret': CURRENT }),
        NOW,
      );

      expect(outcome.authorized).toBe(true);
      expect(outcome.usedPreviousSecret).toBe(false);
    });

    it('rejects the previous secret once the window has closed', () => {
      const service = new MaintenanceSecretService(
        rotatingEnv(pastIso(NOW, 1)),
      );

      const outcome = service.verify(
        request({ 'x-maintenance-secret': PREVIOUS }),
        NOW,
      );

      expect(outcome.authorized).toBe(false);
      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.PREVIOUS_EXPIRED);
    });

    it('rejects the previous secret when no expiry is configured', () => {
      // Fail-closed: a previous secret with no expiry would be a permanent
      // second credential, so it is simply not accepted.
      const service = new MaintenanceSecretService(rotatingEnv());

      const outcome = service.verify(
        request({ 'x-maintenance-secret': PREVIOUS }),
        NOW,
      );

      expect(outcome.authorized).toBe(false);
      expect(outcome.result).toBe(MAINTENANCE_SECRET_RESULT.PREVIOUS_EXPIRED);
    });

    it('rejects the previous secret when the expiry is unparseable', () => {
      const service = new MaintenanceSecretService(
        rotatingEnv('not-a-timestamp'),
      );

      expect(
        service.verify(request({ 'x-maintenance-secret': PREVIOUS }), NOW)
          .authorized,
      ).toBe(false);
      expect(service.isPreviousSecretActive(NOW)).toBe(false);
    });

    it('reports the window as closed exactly at the expiry instant', () => {
      const expiresAt = new Date(NOW);
      const service = new MaintenanceSecretService(
        rotatingEnv(expiresAt.toISOString()),
      );

      expect(service.isPreviousSecretActive(NOW)).toBe(false);
      expect(
        service.verify(request({ 'x-maintenance-secret': PREVIOUS }), NOW)
          .authorized,
      ).toBe(false);
    });

    it('only exposes the previous secret while the window is open', () => {
      const open = new MaintenanceSecretService(
        rotatingEnv(futureIso(NOW, 30)),
      );
      const closed = new MaintenanceSecretService(rotatingEnv(pastIso(NOW, 1)));

      expect(open.activePreviousSecret(NOW)).toBe(PREVIOUS);
      expect(closed.activePreviousSecret(NOW)).toBeUndefined();
    });
  });

  describe('secretsMatch', () => {
    it('matches identical values', () => {
      expect(secretsMatch('abc', 'abc')).toBe(true);
    });

    it('rejects different values of differing length without throwing', () => {
      // timingSafeEqual throws on length mismatch, so values are hashed first.
      expect(secretsMatch('short', 'a-much-longer-value')).toBe(false);
    });

    it('rejects empty values', () => {
      expect(secretsMatch('', '')).toBe(false);
      expect(secretsMatch('abc', '')).toBe(false);
    });
  });

  describe('rotationSnapshot', () => {
    it('never contains secret material', () => {
      const service = new MaintenanceSecretService({
        [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV]: PREVIOUS,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV]: futureIso(NOW, 30),
      });

      const serialized = JSON.stringify(service.rotationSnapshot(NOW));

      expect(serialized).not.toContain(CURRENT);
      expect(serialized).not.toContain(PREVIOUS);
    });

    it('reports an in-progress rotation so it can be alerted on', () => {
      const service = new MaintenanceSecretService({
        [MAINTENANCE_ADMIN_SECRET_ENV]: CURRENT,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_ENV]: PREVIOUS,
        [MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT_ENV]: futureIso(NOW, 30),
      });

      expect(service.rotationSnapshot(NOW)).toMatchObject({
        maintenanceSecretConfigured: true,
        maintenancePreviousSecretConfigured: true,
        maintenanceRotationWindowOpen: true,
      });
    });
  });
});
