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

    it('sanitizes secrets, Stellar private keys, API keys, webhook secrets, and JWTs from status messages (#966)', async () => {
      const client = prisma();
      const stellarSecret = 'SB34ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABC1234';
      const apiKey = 'mux_live_secret1234567890abcdef';
      const webhookSecret = 'whsec_9876543210fedcba';
      const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      client.maintenanceState.findUnique.mockResolvedValue({
        id: 'global',
        enabled: true,
        message: `Maintenance alert with key ${stellarSecret}, api ${apiKey}, hook ${webhookSecret}, jwt ${jwtToken}`,
        retryAfterSeconds: 60,
        enabledAt: NOW,
        updatedBy: 'admin-key-id',
        updatedAt: NOW,
      });

      const service = new MaintenanceService(client as never);
      const status = await service.getStatus();

      expect(status.message).not.toContain(stellarSecret);
      expect(status.message).not.toContain(apiKey);
      expect(status.message).not.toContain(webhookSecret);
      expect(status.message).not.toContain(jwtToken);
      expect(status.message).toContain('[REDACTED_KEY]');
      expect(status.message).toContain('[REDACTED_API_KEY]');
      expect(status.message).toContain('[REDACTED_WEBHOOK_SECRET]');
      expect(status.message).toContain('[REDACTED_JWT]');
      expect(status).not.toHaveProperty('updatedBy');
    });
  });
});
