import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MaintenanceGuard } from './maintenance.guard';
import { MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE } from './maintenance-secret.service';

/**
 * Unit tests for the maintenance write kill-switch and its exemption (#925).
 *
 * Two things are asserted here, and both are availability-critical:
 *
 *  - an unreadable maintenance state **fails closed**, so a DB blip cannot
 *    silently re-open writes an operator believes are frozen; and
 *  - the maintenance toggle itself is **exempt**, so an operator who has frozen
 *    the deployment can still unfreeze it. Without the exemption the
 *    kill-switch is a one-way door.
 */

const ENABLED = {
  enabled: true,
  message: 'ledger upgrade',
  retryAfterSeconds: 60,
};

function prismaReturning(state: unknown): {
  maintenanceState: { findUnique: jest.Mock };
} {
  return {
    maintenanceState: {
      findUnique: jest.fn().mockResolvedValue(state),
    },
  };
}

function reflectorReturning(exempt: boolean): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(exempt),
  } as unknown as Reflector;
}

function contextFor(method: string): ExecutionContext {
  return {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        url: '/v1/wallets',
        res: { setHeader: jest.fn() },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('MaintenanceGuard (#925)', () => {
  it('admits a mutating request when maintenance mode is off', async () => {
    const guard = new MaintenanceGuard(
      prismaReturning(null) as never,
      reflectorReturning(false),
    );

    await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
  });

  it('rejects a mutating request with 503 while maintenance mode is on', async () => {
    const guard = new MaintenanceGuard(
      prismaReturning(ENABLED) as never,
      reflectorReturning(false),
    );

    await expect(guard.canActivate(contextFor('POST'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'admits %s while frozen',
    async (method) => {
      const guard = new MaintenanceGuard(
        prismaReturning(ENABLED) as never,
        reflectorReturning(false),
      );

      await expect(guard.canActivate(contextFor(method))).resolves.toBe(true);
    },
  );

  it('fails closed with a stable code when the state cannot be read', async () => {
    const prisma = prismaReturning(null);
    prisma.maintenanceState.findUnique.mockRejectedValue(new Error('db down'));

    const guard = new MaintenanceGuard(
      prisma as never,
      reflectorReturning(false),
    );

    await expect(guard.canActivate(contextFor('POST'))).rejects.toMatchObject({
      response: { code: MAINTENANCE_STATE_UNAVAILABLE_ERROR_CODE },
    });
  });

  it('does not cache the failure, so recovery is immediate', async () => {
    const prisma = prismaReturning(null);
    prisma.maintenanceState.findUnique.mockRejectedValueOnce(
      new Error('db down'),
    );

    const guard = new MaintenanceGuard(
      prisma as never,
      reflectorReturning(false),
    );

    await expect(guard.canActivate(contextFor('POST'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // The database recovers: the very next request must be admitted without
    // waiting out a cache TTL.
    await expect(guard.canActivate(contextFor('POST'))).resolves.toBe(true);
  });

  describe('AllowDuringMaintenance exemption', () => {
    it('admits the exempt mutating route while frozen', async () => {
      const guard = new MaintenanceGuard(
        prismaReturning(ENABLED) as never,
        reflectorReturning(true),
      );

      await expect(guard.canActivate(contextFor('PATCH'))).resolves.toBe(true);
    });

    it('does not read the database for the exempt route', async () => {
      const prisma = prismaReturning(ENABLED);
      const guard = new MaintenanceGuard(
        prisma as never,
        reflectorReturning(true),
      );

      await guard.canActivate(contextFor('PATCH'));

      expect(prisma.maintenanceState.findUnique).not.toHaveBeenCalled();
    });

    it('does not exempt any other mutating route', async () => {
      // Deny-by-default: only a route that explicitly carries the metadata is
      // exempt, never everything on a controller that also serves writes.
      const guard = new MaintenanceGuard(
        prismaReturning(ENABLED) as never,
        reflectorReturning(false),
      );

      await expect(
        guard.canActivate(contextFor('POST')),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
