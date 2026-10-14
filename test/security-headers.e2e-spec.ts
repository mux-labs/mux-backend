/**
 * E2E test for the baseline security response headers ([#935]).
 *
 * Asserts the headers are present on real HTTP responses — including on error
 * and 404 paths, which is where a lazily-applied middleware usually leaks the
 * framework banner.
 */
import { Test } from '@nestjs/testing';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import request from 'supertest';
import { securityHeaders } from '../src/common/http/security-headers';

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('kaboom');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Security headers baseline (e2e, #935)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts: headers installed before any route.
    app.use(securityHeaders());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets nosniff on a successful response', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('denies framing', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets the referrer policy so query-string ids do not leak', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/ok?userId=user-123')
      .expect(200);

    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not advertise the framework via X-Powered-By', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets a deny-all permissions policy', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['permissions-policy']).not.toContain('*');
  });

  it('applies headers to 404 responses (no route)', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/does-not-exist')
      .expect(404);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('applies headers to 500 responses (handler throws)', async () => {
    const res = await request(app.getHttpServer()).get('/probe/boom');

    expect(res.status).toBe(500);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('omits HSTS by default so local HTTP development is not pinned', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('never emits a Content-Security-Policy on a JSON-only API', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    // CSP governs documents; a no-op header here would imply protection that
    // does not exist.
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('Security headers with HSTS opted in (#935)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(securityHeaders({ SECURITY_HEADERS_HSTS: 'true' }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('emits HSTS when the deployment opts in', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    expect(res.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('still emits the rest of the baseline', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
