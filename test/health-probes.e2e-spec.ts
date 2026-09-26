/**
 * E2E tests for the liveness / readiness probe split (#933).
 *
 * The invariant under test: **liveness never touches a dependency**, so a
 * database outage cannot cascade into a fleet-wide restart. Readiness does
 * check the database and fails closed with `503`.
 *
 * `PrismaService` is stubbed, so the suite needs no database.
 */
import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { HealthController } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma/prisma.service';

jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

describe('Health probes: liveness vs readiness (e2e, #933)', () => {
  let app: INestApplication;
  let pingCheck: jest.Mock;

  beforeEach(async () => {
    pingCheck = jest.fn().mockResolvedValue({ database: { status: 'up' } });

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: {
            // Mirror the real Terminus service: a failing indicator is
            // aggregated and surfaced as a 503 ServiceUnavailableException.
            check: jest.fn(
              async (indicators: Array<() => Promise<any>> = []) => {
                const info: Record<string, unknown> = {};
                const error: Record<string, unknown> = {};

                for (const indicator of indicators) {
                  try {
                    Object.assign(info, await indicator());
                  } catch {
                    Object.assign(error, { database: { status: 'down' } });
                  }
                }

                if (Object.keys(error).length > 0) {
                  throw new ServiceUnavailableException({
                    status: 'error',
                    info,
                    error,
                    details: info,
                  });
                }

                return { status: 'ok', info, error, details: info };
              },
            ),
          },
        },
        { provide: PrismaHealthIndicator, useValue: { pingCheck } },
        { provide: PrismaService, useValue: {} },
        {
          provide: ConfigService,
          useValue: { get: (_k: string, d: string) => d },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('liveness (no dependencies)', () => {
    it('serves 200 at /v1/health', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/health')
        .expect(200);

      expect(res.body).toEqual({ status: 'ok', build: { gitSha: 'unknown' } });
    });

    it('serves 200 at the explicit /v1/health/live alias', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/health/live')
        .expect(200);

      expect(res.body).toMatchObject({ status: 'ok' });
    });

    it('does not query the database at all', async () => {
      await request(app.getHttpServer()).get('/v1/health').expect(200);

      expect(pingCheck).not.toHaveBeenCalled();
    });

    it('stays 200 while the database is down (no restart storm)', async () => {
      pingCheck.mockRejectedValue(new Error('connection refused'));

      await request(app.getHttpServer()).get('/v1/health').expect(200);

      expect(pingCheck).not.toHaveBeenCalled();
    });
  });

  describe('readiness (fails closed on dependency outage)', () => {
    it('serves 200 at /v1/health/ready when the database responds', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/health/ready')
        .expect(200);

      expect(res.body).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' } },
      });
    });

    it('actually pings the database', async () => {
      await request(app.getHttpServer()).get('/v1/health/ready').expect(200);

      expect(pingCheck).toHaveBeenCalledWith('database', { timeout: 3000 });
    });

    it('serves 503 at /v1/health/ready when the database is down', async () => {
      pingCheck.mockRejectedValue(new Error('connection refused'));

      const res = await request(app.getHttpServer())
        .get('/v1/health/ready')
        .expect(503);

      // Fail-closed: never a 200 while a required dependency is unavailable.
      expect(res.body).toMatchObject({ status: 'error' });
    });

    it('never leaks secret or key material in the failure body', async () => {
      pingCheck.mockRejectedValue(new Error('connection refused'));

      const res = await request(app.getHttpServer())
        .get('/v1/health/ready')
        .expect(503);

      expect(JSON.stringify(res.body)).not.toMatch(
        /secret|private[_-]?key|encryptedSecret/i,
      );
    });
  });

  describe('authentication', () => {
    it('does not require an API key on either probe', async () => {
      await request(app.getHttpServer()).get('/v1/health').expect(200);
      await request(app.getHttpServer()).get('/v1/health/ready').expect(200);
    });
  });
});
