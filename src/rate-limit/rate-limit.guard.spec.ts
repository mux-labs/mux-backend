import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard, IS_SENSITIVE_ENDPOINT } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let rateLimitService: jest.Mocked<
    Pick<RateLimitService, 'checkRateLimit' | 'getConfig' | 'cleanupOldRecords'>
  >;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;

  function createMockExecutionContext(overrides: {
    apiKeyInfo?: any | null;
    path?: string;
    method?: string;
    routePath?: string;
  } = {}): ExecutionContext {
    const headers: Record<string, string> = {};
    const response = {
      setHeader: jest.fn(),
      getHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const hasApiKeyInfo = 'apiKeyInfo' in overrides;
    const request = {
      apiKeyInfo: hasApiKeyInfo
        ? overrides.apiKeyInfo
        : {
            id: 'test-api-key-id',
            project: { rateLimitRpm: 100 },
          },
      path: overrides.path ?? '/test',
      method: overrides.method ?? 'GET',
      route: overrides.routePath ? { path: overrides.routePath } : undefined,
      headers,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  beforeEach(async () => {
    rateLimitService = {
      checkRateLimit: jest.fn(),
      getConfig: jest.fn(),
      cleanupOldRecords: jest.fn(),
    };

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: RateLimitService, useValue: rateLimitService },
        { provide: Reflector, useValue: reflector },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
  });

  describe('header setting', () => {
    it('should set X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset headers on success', async () => {
      const now = Date.now();
      (rateLimitService.checkRateLimit as jest.Mock).mockResolvedValue({
        allowed: true,
        remaining: 99,
        resetTime: new Date(now + 60000),
        limit: 100,
      });

      const ctx = createMockExecutionContext();
      const response = ctx.switchToHttp().getResponse<any>();

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Limit',
        100,
      );
      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Remaining',
        99,
      );
      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        Math.ceil((now + 60000) / 1000),
      );
    });

    it('should set Retry-After header when rate limit is exceeded', async () => {
      const now = Date.now();
      const resetTime = new Date(now + 30000);
      (rateLimitService.checkRateLimit as jest.Mock).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime,
        limit: 100,
      });

      const ctx = createMockExecutionContext();
      const response = ctx.switchToHttp().getResponse<any>();

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

      const retryAfterCall = response.setHeader.mock.calls.find(
        (call: string[]) => call[0] === 'Retry-After',
      );
      expect(retryAfterCall).toBeDefined();
    });

    it('should pass through when no API key info is present (public endpoint)', async () => {
      const ctx = createMockExecutionContext({ apiKeyInfo: null });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(rateLimitService.checkRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('should throw HttpException with 429 when rate limit exceeded', async () => {
      (rateLimitService.checkRateLimit as jest.Mock).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime: new Date(Date.now() + 60000),
        limit: 100,
      });

      const ctx = createMockExecutionContext();

      try {
        await guard.canActivate(ctx);
        fail('Expected HttpException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
        const response = (error as HttpException).getResponse();
        expect(response).toMatchObject({
          statusCode: 429,
          message: expect.stringContaining('Rate limit exceeded'),
        });
      }
    });

    it('should include retryAfter in the error response body', async () => {
      const now = Date.now();
      (rateLimitService.checkRateLimit as jest.Mock).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetTime: new Date(now + 30000),
        limit: 100,
      });

      const ctx = createMockExecutionContext();

      try {
        await guard.canActivate(ctx);
        fail('Expected HttpException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        const response = (error as HttpException).getResponse();
        expect(response).toMatchObject({
          statusCode: 429,
          retryAfter: expect.any(Number),
        });
      }
    });
  });

  describe('sensitive endpoints', () => {
    it('should pass isSensitive=true when endpoint is decorated as sensitive', async () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
      (rateLimitService.checkRateLimit as jest.Mock).mockResolvedValue({
        allowed: true,
        remaining: 9,
        resetTime: new Date(Date.now() + 60000),
        limit: 10,
      });

      const ctx = createMockExecutionContext();
      await guard.canActivate(ctx);

      expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith(
        'test-api-key-id',
        expect.any(String),
        100,
        true,
      );
    });
  });

  describe('endpoint path normalization', () => {
    it('should normalize paths with UUIDs', async () => {
      (rateLimitService.checkRateLimit as jest.Mock).mockResolvedValue({
        allowed: true,
        remaining: 99,
        resetTime: new Date(Date.now() + 60000),
        limit: 100,
      });

      const ctx = createMockExecutionContext({
        path: '/wallets/550e8400-e29b-41d4-a716-446655440000',
        method: 'GET',
        routePath: '/wallets/:id',
      });

      await guard.canActivate(ctx);

      expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/GET \/wallets\/:id/),
        expect.any(Number),
        false,
      );
    });
  });
});
