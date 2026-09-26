import { ServiceUnavailableException } from '@nestjs/common';
import { HealthBuildInfo, HealthController } from './health.controller';

function makeController(overrides: { checkImpl?: jest.Mock; gitSha?: string }) {
  const mockHealthCheckService = {
    check:
      overrides.checkImpl ??
      // Mirror the real HealthCheckService: invoke each indicator and fold the
      // results into the Terminus response shape. This is what proves the
      // controller actually wires the database indicator up.
      jest.fn(async (indicators: Array<() => Promise<any>> = []) => {
        const info: Record<string, unknown> = {};
        for (const indicator of indicators) {
          Object.assign(info, await indicator());
        }
        return { status: 'ok', info, error: {}, details: info };
      }),
  };
  const mockPrismaIndicator = {
    pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }),
  };
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

  return {
    controller,
    mockHealthCheckService,
    mockPrismaIndicator,
    mockConfigService,
  };
}

describe('HealthController', () => {
  describe('live – liveness probe (no dependencies)', () => {
    it('returns ok with the build gitSha', () => {
      const { controller } = makeController({ gitSha: 'abc1234' });

      expect(controller.live()).toEqual({
        status: 'ok',
        build: { gitSha: 'abc1234' },
      });
    });

    it('defaults gitSha to "unknown" when GIT_SHA is not set', () => {
      const { controller } = makeController({});

      expect(controller.live()).toEqual({
        status: 'ok',
        build: { gitSha: 'unknown' },
      });
    });

    it('stays 200 while the database is down (no restart storm)', () => {
      // The DB ping rejects, but liveness must not consult it at all.
      const { controller, mockHealthCheckService } = makeController({
        checkImpl: jest.fn().mockRejectedValue(new Error('db down')),
      });

      expect(controller.live()).toEqual({
        status: 'ok',
        build: { gitSha: 'unknown' },
      });
      expect(mockHealthCheckService.check).not.toHaveBeenCalled();
    });

    it('exposes an explicit /health/live alias with identical output', () => {
      const { controller } = makeController({ gitSha: 'abc1234' });

      expect(controller.liveAlias()).toEqual(controller.live());
    });
  });

  describe('check – readiness probe (success path)', () => {
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

      expect(result).toMatchObject({ build: { gitSha: 'unknown' } });
    });

    it('actually runs the database indicator', async () => {
      const { controller, mockPrismaIndicator } = makeController({});

      await controller.check();

      expect(mockPrismaIndicator.pingCheck).toHaveBeenCalledWith('database', {
        timeout: 3000,
      });
    });
  });

  describe('check – failure path', () => {
    it('re-throws 503 with build.gitSha merged into the error body when the DB is down', async () => {
      interface ErrorBody {
        build?: HealthBuildInfo;
        error: { database: { status: string } };
      }

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
        const response = (
          err as ServiceUnavailableException
        ).getResponse() as ErrorBody;
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
