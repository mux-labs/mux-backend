import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import {
  AUTH_REQUIRED_ERROR_CODE,
  HttpExceptionFilter,
  PUBLIC_ENDPOINT_ALLOWLIST,
} from './http-exception.filter';

type FilterInternals = {
  isPublicEndpoint(request: Request): boolean;
};

const asRequest = (path: string, url = path): Request =>
  ({ path, url, method: 'GET', headers: {} }) as unknown as Request;

const isPublic = (filter: HttpExceptionFilter, path: string, url?: string) =>
  (filter as unknown as FilterInternals).isPublicEndpoint(
    asRequest(path, url),
  );

describe('HttpExceptionFilter public endpoint catalog', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  describe('exact matches', () => {
    it.each(['/health', '/metrics', '/error-codes', '/v1/error-codes'])(
      'treats %s as public',
      (path) => {
        expect(isPublic(filter, path)).toBe(true);
      },
    );

    it('does not treat a sub-path of an exact entry as public', () => {
      expect(isPublic(filter, '/metrics/extra')).toBe(false);
      expect(isPublic(filter, '/error-codes/extra')).toBe(false);
    });

    it('does not treat a lookalike prefix as public', () => {
      expect(isPublic(filter, '/healthz')).toBe(false);
      expect(isPublic(filter, '/metricsx')).toBe(false);
    });
  });

  describe('prefix (/*) matches', () => {
    it('treats the bare prefix and its descendants as public', () => {
      expect(isPublic(filter, '/health')).toBe(true);
      expect(isPublic(filter, '/health/live')).toBe(true);
      expect(isPublic(filter, '/health/ready/deep')).toBe(true);
    });

    it('does not treat a lookalike prefix as public', () => {
      expect(isPublic(filter, '/healthcheck')).toBe(false);
    });
  });

  describe('query-string stripping', () => {
    it('ignores the query string when matching', () => {
      expect(isPublic(filter, '/health', '/health?verbose=1')).toBe(true);
      expect(isPublic(filter, '/error-codes', '/error-codes?x=1&y=2')).toBe(
        true,
      );
      expect(isPublic(filter, '/health/live', '/health/live?probe=1')).toBe(
        true,
      );
    });

    it('does not let a query string make a protected route public', () => {
      expect(isPublic(filter, '/wallets', '/wallets?path=/health')).toBe(false);
    });
  });

  describe('unmatched routes are protected (deny-by-default)', () => {
    it.each(['/', '/wallets', '/v1/wallets', '/auth/login/extra', '/admin'])(
      'treats %s as protected',
      (path) => {
        expect(isPublic(filter, path)).toBe(false);
      },
    );

    it('fails closed with AUTH_REQUIRED for an unmatched route without credentials', () => {
      const request = asRequest('/wallets', '/wallets?limit=10');
      const json = jest.fn();
      const status = jest.fn().mockReturnValue({ json });
      const host = {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({ status }) as unknown as Response,
        }),
      } as unknown as ArgumentsHost;

      filter.catch(
        new HttpException('Boom', HttpStatus.BAD_REQUEST),
        host,
      );

      expect(status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: HttpStatus.UNAUTHORIZED,
          errorCode: AUTH_REQUIRED_ERROR_CODE,
        }),
      );
    });

    it('keeps the allowlist deny-by-default (no wildcard catch-all entries)', () => {
      expect(PUBLIC_ENDPOINT_ALLOWLIST).not.toContain('/*');
      expect(PUBLIC_ENDPOINT_ALLOWLIST).not.toContain('*');
    });
  });
});
