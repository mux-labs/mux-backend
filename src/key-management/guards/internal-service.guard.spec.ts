import {
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  INTERNAL_API_KEY_ENV,
  INTERNAL_API_KEY_HEADER,
  InternalServiceGuard,
} from './internal-service.guard';

function config(value?: string): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key === INTERNAL_API_KEY_ENV ? (value ?? defaultValue) : defaultValue,
  } as unknown as ConfigService;
}

function contextWithHeaders(
  headers: Record<string, string | string[]>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip: '10.0.0.1' }),
    }),
  } as unknown as ExecutionContext;
}

describe('InternalServiceGuard (#690)', () => {
  const SECRET = 'super-secret-internal-key';

  describe('fail-closed when unconfigured', () => {
    it('denies every request when the secret is unset', () => {
      const guard = new InternalServiceGuard(config());
      expect(() =>
        guard.canActivate(
          contextWithHeaders({ [INTERNAL_API_KEY_HEADER]: SECRET }),
        ),
      ).toThrow(ServiceUnavailableException);
    });

    it('treats a blank secret as unconfigured', () => {
      const guard = new InternalServiceGuard(config('   '));
      expect(() => guard.canActivate(contextWithHeaders({}))).toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('when configured', () => {
    const guard = new InternalServiceGuard(config(SECRET));

    it('allows a request with the correct key', () => {
      expect(
        guard.canActivate(
          contextWithHeaders({ [INTERNAL_API_KEY_HEADER]: SECRET }),
        ),
      ).toBe(true);
    });

    it('rejects a request with no header', () => {
      expect(() => guard.canActivate(contextWithHeaders({}))).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a request with a wrong key', () => {
      expect(() =>
        guard.canActivate(
          contextWithHeaders({ [INTERNAL_API_KEY_HEADER]: 'nope' }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('rejects a key of matching length but different content', () => {
      expect(() =>
        guard.canActivate(
          contextWithHeaders({
            [INTERNAL_API_KEY_HEADER]: 'x'.repeat(SECRET.length),
          }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('HTTP integration', () => {
    @Controller('guarded')
    @UseGuards(InternalServiceGuard)
    class GuardedController {
      @Get()
      ok() {
        return { ok: true };
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
      await request(app.getHttpServer()).get('/guarded').expect(401);
    });

    it('returns 401 with a wrong key', async () => {
      await request(app.getHttpServer())
        .get('/guarded')
        .set(INTERNAL_API_KEY_HEADER, 'wrong')
        .expect(401);
    });

    it('returns 200 with the correct key', async () => {
      await request(app.getHttpServer())
        .get('/guarded')
        .set(INTERNAL_API_KEY_HEADER, SECRET)
        .expect(200, { ok: true });
    });
  });
});
