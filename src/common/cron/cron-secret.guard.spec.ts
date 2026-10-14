import {
  Controller,
  ExecutionContext,
  Post,
  INestApplication,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  CRON_SECRET_ENV,
  CRON_SECRET_HEADER,
  CronSecretGuard,
} from './cron-secret.guard';

function config(value?: string): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key === CRON_SECRET_ENV ? (value ?? defaultValue) : defaultValue,
  } as unknown as ConfigService;
}

function contextWithHeaders(
  headers: Record<string, string | string[]>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip: '10.0.0.1', path: '/test' }),
    }),
  } as unknown as ExecutionContext;
}

describe('CronSecretGuard (#801)', () => {
  const SECRET = 'super-secret-cron-value';

  describe('fail-closed when unconfigured', () => {
    it('denies every request when the secret is unset, even with a header supplied', () => {
      const guard = new CronSecretGuard(config());
      expect(() =>
        guard.canActivate(contextWithHeaders({ [CRON_SECRET_HEADER]: SECRET })),
      ).toThrow(UnauthorizedException);
    });

    it('treats a blank/whitespace-only secret as unconfigured', () => {
      const guard = new CronSecretGuard(config('   '));
      expect(() => guard.canActivate(contextWithHeaders({}))).toThrow(
        UnauthorizedException,
      );
    });

    it('never falls back to any implicit "allow" or mock credential', () => {
      const guard = new CronSecretGuard(config());
      // Even an empty-string header must not be treated as a match against
      // an empty/unconfigured secret.
      expect(() =>
        guard.canActivate(contextWithHeaders({ [CRON_SECRET_HEADER]: '' })),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('when configured', () => {
    const guard = new CronSecretGuard(config(SECRET));

    it('allows a request with the correct secret', () => {
      expect(
        guard.canActivate(contextWithHeaders({ [CRON_SECRET_HEADER]: SECRET })),
      ).toBe(true);
    });

    it('rejects a request with no header', () => {
      expect(() => guard.canActivate(contextWithHeaders({}))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a request with a wrong secret', () => {
      expect(() =>
        guard.canActivate(contextWithHeaders({ [CRON_SECRET_HEADER]: 'nope' })),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a secret of matching length but different content (guards against naive comparison)', () => {
      expect(() =>
        guard.canActivate(
          contextWithHeaders({
            [CRON_SECRET_HEADER]: 'x'.repeat(SECRET.length),
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a header supplied as an array (multiple headers) using only the first value', () => {
      expect(() =>
        guard.canActivate(
          contextWithHeaders({ [CRON_SECRET_HEADER]: ['nope', SECRET] }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('project API keys are not a substitute for the cron secret', () => {
    it('a request carrying only an Authorization header (project API key) is still rejected', () => {
      const guard = new CronSecretGuard(config(SECRET));
      expect(() =>
        guard.canActivate(
          contextWithHeaders({ authorization: 'Bearer mux_live_something' }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('HTTP integration', () => {
    @Controller('internal-guarded')
    @UseGuards(CronSecretGuard)
    class GuardedController {
      @Post('poll-pending')
      poll() {
        return { processed: 0 };
      }
    }

    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [GuardedController],
        providers: [{ provide: ConfigService, useValue: config(SECRET) }],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns 401 without the header', async () => {
      await request(app.getHttpServer())
        .post('/internal-guarded/poll-pending')
        .expect(401);
    });

    it('returns 401 with only a Bearer/API-key style header', async () => {
      await request(app.getHttpServer())
        .post('/internal-guarded/poll-pending')
        .set('Authorization', 'Bearer mux_live_something')
        .expect(401);
    });

    it('returns 401 with a wrong secret', async () => {
      await request(app.getHttpServer())
        .post('/internal-guarded/poll-pending')
        .set(CRON_SECRET_HEADER, 'wrong')
        .expect(401);
    });

    it('returns 200 with the correct secret', async () => {
      await request(app.getHttpServer())
        .post('/internal-guarded/poll-pending')
        .set(CRON_SECRET_HEADER, SECRET)
        .expect(201, { processed: 0 });
    });
  });
});
