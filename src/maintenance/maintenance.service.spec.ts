import { MaintenanceService } from './maintenance.service';

/**
 * Unit tests for the maintenance state service (#925).
 *
 * The service is the audit record of who froze the writes, so the tests assert
 * that the caller identity is server-supplied and that a read failure is never
 * laundered into "not in maintenance".
 */

const NOW = new Date('2026-09-28T12:00:00.000Z');

/** The single persisted row the service reads and writes. */
interface StateRow {
  enabled: boolean;
  message: string | null;
  retryAfterSeconds: number | null;
  enabledAt: Date | null;
  updatedBy: string;
  updatedAt: Date;
}

interface PrismaStub {
  maintenanceState: {
    findUnique: jest.Mock<Promise<unknown>, []>;
    upsert: jest.Mock<
      Promise<StateRow>,
      [{ create: StateRow; update: StateRow }]
    >;
  };
}

function prisma(): PrismaStub {
  return {
    maintenanceState: {
      findUnique: jest.fn<Promise<unknown>, []>().mockResolvedValue(null),
      upsert: jest
        .fn<Promise<StateRow>, [{ create: StateRow; update: StateRow }]>()
        .mockImplementation(({ create }) =>
          Promise.resolve({ ...create, updatedAt: NOW }),
        ),
    },
  };
}

describe('MaintenanceService (#925)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getStatus', () => {
    it('reports "not in maintenance" when no row exists', async () => {
      const service = new MaintenanceService(prisma() as never);

      await expect(service.getStatus()).resolves.toEqual({
        enabled: false,
        message: null,
        retryAfterSeconds: null,
        enabledAt: null,
        updatedAt: null,
      });
    });

    it('propagates a read failure instead of reporting a safe default', async () => {
      // Swallowing this would tell an operator the fleet is writable when the
      // guard is failing every write closed.
      const client = prisma();
      client.maintenanceState.findUnique.mockRejectedValue(
        new Error('db down'),
      );

      const service = new MaintenanceService(client as never);

      await expect(service.getStatus()).rejects.toThrow('db down');
    });
  });

  describe('updateStatus', () => {
    it('records the server-resolved caller identity', async () => {
      const client = prisma();
      const service = new MaintenanceService(client as never);

      await service.updateStatus({ enabled: true }, 'api-key-123');

      const call = client.maintenanceState.upsert.mock.calls[0];
      expect(call?.[0].update.updatedBy).toBe('api-key-123');
    });

    it('stamps enabledAt when enabling and clears it when disabling', async () => {
      const client = prisma();
      const service = new MaintenanceService(client as never);

      await service.updateStatus({ enabled: true }, 'api-key-123');
      const firstCall = client.maintenanceState.upsert.mock.calls[0];
      expect(firstCall?.[0].update.enabledAt).toEqual(NOW);

      await service.updateStatus({ enabled: false }, 'api-key-123');
      const secondCall = client.maintenanceState.upsert.mock.calls[1];
      expect(secondCall?.[0].update.enabledAt).toBeNull();
    });

    it('normalizes an omitted message and retry delay to null', async () => {
      const client = prisma();
      const service = new MaintenanceService(client as never);

      const status = await service.updateStatus({ enabled: true }, 'internal');

      expect(status.message).toBeNull();
      expect(status.retryAfterSeconds).toBeNull();
    });
  });
});
