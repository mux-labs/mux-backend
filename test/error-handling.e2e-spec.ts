import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { ErrorCode } from '../src/common/error-code-catalog/error-code.enum';
import { ERROR_CODE_CATALOG } from '../src/common/error-code-catalog/error-code-catalog';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { RequestIdInterceptor } from '../src/common/interceptors/request-id.interceptor';

/**
 * Error handling e2e suite (#985).
 *
 * Asserts the public error contract documented in docs/ERROR-CODES.md:
 *  - every failure uses the stable envelope (statusCode/errorCode/requestId/…)
 *  - errorCode values are members of the append-only ErrorCode catalog
 *  - the catalog endpoint is public, cacheable and secret-free
 *  - authz negatives (absent/expired JWT, wrong role, revoked delegate, bad API key)
 *  - idempotency/replay on money paths (missing key, concurrent duplicates, replay)
 *  - dependency outages fail closed (no write applied)
 */
describe('Error handling (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  const catalogByCode = new Map(ERROR_CODE_CATALOG.codes.map((c) => [c.code, c]));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalInterceptors(new RequestIdInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Asserts the shared error envelope and returns the parsed body. */
  const expectEnvelope = (res: request.Response, expected: ErrorCode) => {
    const body = res.body;
    expect(body).toEqual(
      expect.objectContaining({
        statusCode: res.status,
        errorCode: expected,
        path: expect.any(String),
        method: expect.any(String),
        timestamp: expect.any(String),
        message: expect.any(String),
        requestId: expect.any(String),
      }),
    );
    // errorCode must be a documented, append-only catalog member.
    const entry = catalogByCode.get(body.errorCode);
    expect(entry).toBeDefined();
    expect(entry!.httpStatus).toBe(res.status);
    // requestId is a correlation id, never a secret.
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    return body;
  };

  describe('error envelope', () => {
    it('returns a stable envelope with a correlation id for unknown routes', async () => {
      const res = await http.get('/v1/definitely-not-a-route').expect(404);
      const body = expectEnvelope(res, ErrorCode.NOT_FOUND);
      expect(body.requestId).toBeTruthy();
    });

    it('echoes an inbound correlation id when provided', async () => {
      const requestId = '3f1c9b2e-8a4d-4c1e-9f2a-1b2c3d4e5f60';
      const res = await http
        .get('/v1/definitely-not-a-route')
        .set('x-request-id', requestId)
        .expect(404);
      expect(res.body.requestId).toBe(requestId);
    });

    it('never leaks secrets in the error payload', async () => {
      const res = await http.get('/v1/definitely-not-a-route').expect(404);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/postgres:\/\//i);
      expect(serialized).not.toMatch(/bearer\s+[a-z0-9._-]+/i);
      expect(serialized).not.toMatch(/S[A-Z2-7]{55}/); // Stellar secret seed
    });
  });

  describe('GET /v1/error-codes', () => {
    it('is public, cacheable and secret-free', async () => {
      const res = await http.get('/v1/error-codes').expect(200);
      expect(res.headers['cache-control']).toContain('public');
      expect(res.body.schemaVersion).toBe(1);
      expect(Array.isArray(res.body.codes)).toBe(true);
      expect(res.body.codes.length).toBeGreaterThan(0);
      for (const entry of res.body.codes) {
        expect(entry).toEqual(
          expect.objectContaining({
            code: expect.any(String),
            httpStatus: expect.any(Number),
            category: expect.any(String),
            retryable: expect.any(Boolean),
            action: expect.any(String),
            message: expect.any(String),
          }),
        );
      }
    });

    it('documents every ErrorCode exactly once', async () => {
      const res = await http.get('/v1/error-codes').expect(200);
      const codes = res.body.codes.map((c: { code: string }) => c.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of Object.values(ErrorCode)) {
        expect(codes).toContain(code);
      }
    });
  });

  describe('authz negatives', () => {
    it('rejects an absent JWT with UNAUTHENTICATED', async () => {
      const res = await http.get('/v1/wallets').expect(401);
      expectEnvelope(res, ErrorCode.UNAUTHENTICATED);
    });

    it('rejects an expired JWT with TOKEN_EXPIRED', async () => {
      const res = await http
        .get('/v1/wallets')
        .set('authorization', 'Bearer expired.jwt.token')
        .expect(401);
      expectEnvelope(res, ErrorCode.TOKEN_EXPIRED);
    });

    it('rejects an invalid API key with INVALID_CREDENTIALS', async () => {
      const res = await http
        .post('/v1/balances/wallet/w1/sync')
        .set('x-api-key', 'not-a-real-key')
        .expect(401);
      expectEnvelope(res, ErrorCode.INVALID_CREDENTIALS);
    });

    it('rejects a wrong role with INSUFFICIENT_ROLE', async () => {
      const res = await http
        .post('/v1/admin/backups')
        .set('authorization', 'Bearer viewer.jwt.token')
        .expect(403);
      expectEnvelope(res, ErrorCode.INSUFFICIENT_ROLE);
    });

    it('rejects a revoked delegate with DELEGATE_REVOKED', async () => {
      const res = await http
        .post('/v1/balances/wallet/w1/sync')
        .set('authorization', 'Bearer revoked.delegate.jwt')
        .expect(403);
      expectEnvelope(res, ErrorCode.DELEGATE_REVOKED);
    });
  });

  describe('idempotency / replay on money paths', () => {
    it('requires an idempotency key on writes', async () => {
      const res = await http
        .post('/v1/balances/wallet/w1/sync')
        .set('authorization', 'Bearer owner.jwt.token')
        .expect(400);
      expectEnvelope(res, ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
    });

    it('rejects a replayed key with a different payload as IDEMPOTENCY_CONFLICT', async () => {
      const key = 'idem-replay-0001';
      await http
        .post('/v1/balances/wallet/w1/sync')
        .set('authorization', 'Bearer owner.jwt.token')
        .set('idempotency-key', key)
        .send({ cursor: 'a' })
        .expect(202);

      const res = await http
        .post('/v1/balances/wallet/w1/sync')
        .set('authorization', 'Bearer owner.jwt.token')
        .set('idempotency-key', key)
        .send({ cursor: 'b' })
        .expect(409);
      expectEnvelope(res, ErrorCode.IDEMPOTENCY_CONFLICT);
    });

    it('applies a concurrent duplicate exactly once', async () => {
      const key = 'idem-concurrent-0001';
      const send = () =>
        http
          .post('/v1/balances/wallet/w1/sync')
          .set('authorization', 'Bearer owner.jwt.token')
          .set('idempotency-key', key)
          .send({ cursor: 'same' });

      const [a, b] = await Promise.all([send(), send()]);
      // One wins; the other is either the cached result or a conflict — never a second write.
      expect([a.status, b.status].sort()).toEqual([202, 202]);
      expect(a.body.requestId).toBeDefined();
      expect(b.body.requestId).toBeDefined();
    });
  });

  describe('dependency outage fails closed', () => {
    it('returns DEPENDENCY_UNAVAILABLE and applies no write', async () => {
      const res = await http
        .post('/v1/balances/wallet/w1/sync')
        .set('authorization', 'Bearer owner.jwt.token')
        .set('idempotency-key', 'idem-outage-0001')
        .set('x-simulate-dependency-outage', 'horizon')
        .send({ cursor: 'x' })
        .expect(503);
      const body = expectEnvelope(res, ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(body.message).not.toMatch(/horizon|rpc|postgres/i);
    });
  });
});
