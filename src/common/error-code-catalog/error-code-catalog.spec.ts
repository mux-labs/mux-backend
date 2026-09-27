import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ErrorCodeCatalogModule } from './error-code-catalog.module';
import {
  ERROR_CODE_CATALOG,
  buildErrorCodeCatalogResponse,
  getErrorCodeEntry,
  type ErrorCodeCatalogResponse,
} from '../dto/error-code-catalog';
import { DEFAULT_STATUS_BY_CODE, ErrorCode } from '../dto/error-envelope.dto';

/**
 * #949 — the catalog is part of the public contract, so these are guardrails
 * against silent drift rather than behaviour tests.
 */
describe('ErrorCodeCatalog', () => {
  it('documents every ErrorCode exactly once (exhaustive, no duplicates)', () => {
    const catalogCodes = ERROR_CODE_CATALOG.map((entry) => entry.code);
    const enumCodes = Object.values(ErrorCode);

    expect(new Set(catalogCodes).size).toBe(catalogCodes.length);
    expect([...catalogCodes].sort()).toEqual([...enumCodes].sort());
  });

  it('agrees with the envelope builder on the HTTP status for every code', () => {
    for (const entry of ERROR_CODE_CATALOG) {
      expect(entry.httpStatus).toBe(DEFAULT_STATUS_BY_CODE[entry.code]);
    }
  });

  it('never leaks secret-looking material in a client-safe message', () => {
    for (const entry of ERROR_CODE_CATALOG) {
      expect(entry.message).not.toMatch(
        /(S[A-Z2-7]{55}|eyJ[A-Za-z0-9_-]{5,}\.|BEGIN [A-Z ]*PRIVATE KEY|Bearer\s)/,
      );
    }
  });

  it('marks dependency/rate-limit failures retryable and auth failures not', () => {
    expect(getErrorCodeEntry(ErrorCode.DEPENDENCY_UNAVAILABLE)).toMatchObject({
      retryable: true,
      httpStatus: 503,
    });
    expect(getErrorCodeEntry(ErrorCode.RATE_LIMITED)).toMatchObject({
      retryable: true,
      action: 'RETRY_WITH_BACKOFF',
    });
    expect(getErrorCodeEntry(ErrorCode.TOKEN_EXPIRED)).toMatchObject({
      retryable: false,
      action: 'REFRESH_TOKEN',
    });
    expect(getErrorCodeEntry(ErrorCode.DELEGATE_REVOKED)).toMatchObject({
      retryable: false,
      action: 'REQUEST_ROLE',
    });
  });

  it('returns undefined for an unknown code', () => {
    expect(getErrorCodeEntry('NOT_A_REAL_CODE')).toBeUndefined();
  });

  it('serves a versioned, stable payload', () => {
    expect(buildErrorCodeCatalogResponse().schemaVersion).toBe(1);
    expect(buildErrorCodeCatalogResponse().codes.length).toBe(
      ERROR_CODE_CATALOG.length,
    );
  });
});

describe('ErrorCodeCatalogController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ErrorCodeCatalogModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/error-codes returns the catalog without credentials', async () => {
    const res = await request(app.getHttpServer()).get('/v1/error-codes');
    const body = res.body as ErrorCodeCatalogResponse;

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(body.schemaVersion).toBe(1);
    expect(body.codes.length).toBe(ERROR_CODE_CATALOG.length);

    const first = body.codes[0];
    expect(typeof first.code).toBe('string');
    expect(typeof first.httpStatus).toBe('number');
    expect(typeof first.category).toBe('string');
    expect(typeof first.retryable).toBe('boolean');
    expect(typeof first.action).toBe('string');
    expect(typeof first.message).toBe('string');
  });
});
