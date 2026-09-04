import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

function makeController(overrides: {
  checkImpl?: jest.Mock;
  gitSha?: string;
}) {
  const mockHealthCheckService = {
    check:
      overrides.checkImpl ??
      jest.fn().mockResolvedValue({
        status: 'ok',
        info: { database: { status: 'up' } },
        error: {},
        details: { database: { status: 'up' } },
      }),
  };
  const mockPrismaIndicator = { pingCheck: jest.fn() };
  const mockPrisma = {};
  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue: string) => {
      if (key === 'GIT_SHA') return overrides.gitSha ?? defaultValue;
      return defaultValue;
    }),
  };

  const controller = new HealthController(
    mockHealthCheckService as any,
    mockPrismaIndicator as any,
    mockPrisma as any,
    mockConfigService as any,
  );

  return { controller, mockHealthCheckService, mockConfigService };
}

describe('HealthController', () => {
  describe('check – success path', () => {
    it('returns the health result with build.gitSha included', async () => {
      const { controller } = makeController({ gitSha: 'abc1234' });

      const result = await controller.check();

      expect(result).toEqual({
        status: 'ok',
        info: { database: { status: 'up' } },
        error: {},
        details: { database: { status: 'up' } },
        build: { gitSha: 'abc1234' },
      });
    });

    it('defaults gitSha to "unknown" when GIT_SHA is not set', async () => {
      const { controller } = makeController({});

      const result = await controller.check();

      expect((result as any).build).toEqual({ gitSha: 'unknown' });
    });
  });

  describe('check – failure path', () => {
    it('re-throws 503 with build.gitSha merged into the error body when the DB is down', async () => {
      const dbError = new ServiceUnavailableException({
        status: 'error',
        info: {},
        error: { database: { status: 'down', message: 'connection refused' } },
        details: {
          database: { status: 'down', message: 'connection refused' },
        },
      });

      const { controller } = makeController({
        checkImpl: jest.fn().mockRejectedValue(dbError),
        gitSha: 'deadbeef',
      });

      await expect(controller.check()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      try {
        await controller.check();
        throw new Error('expected controller.check() to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const response = (err as ServiceUnavailableException).getResponse() as any;
        expect(response.build).toEqual({ gitSha: 'deadbeef' });
        expect(response.error.database.status).toBe('down');
        // No secrets, only a commit hash, ever end up in the response.
        expect(JSON.stringify(response)).not.toMatch(/secret|private[_-]?key/i);
      }
    });

    it('re-throws non-ServiceUnavailableException errors unchanged', async () => {
      const otherError = new Error('unexpected failure');
      const { controller } = makeController({
        checkImpl: jest.fn().mockRejectedValue(otherError),
      });

      await expect(controller.check()).rejects.toThrow('unexpected failure');
    });
  });
});
