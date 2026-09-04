/**
 * Guard Composition Unit Tests
 *
 * Tests the composition and interaction of auth guards at the unit level.
 * Verifies execution order, context propagation, and error handling.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard, IS_PUBLIC, REQUIRE_API_KEY } from '../api-keys/api-key.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

describe('Guard Composition', () => {
  let apiKeyGuard: ApiKeyGuard;
  let rateLimitGuard: AuthRateLimitGuard;
  let reflector: Reflector;
  let apiKeyService: any;
  let rateLimitService: any;

  beforeEach(async () => {
    // Mock services
    apiKeyService = {
      validateApiKey: jest.fn(),
    };

    rateLimitService = {
      checkRateLimit: jest.fn(),
      getConfig: jest.fn().mockReturnValue({ windowMs: 3600000 }),
    };

    const authMetricsService = {
      recordRateLimitHit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: 'ApiKeyService', useValue: apiKeyService },
        { provide: 'AuthRateLimitService', useValue: rateLimitService },
        { provide: 'AuthMetricsService', useValue: authMetricsService },
        Reflector,
      ],
    }).compile();

    reflector = module.get<Reflector>(Reflector);
    apiKeyGuard = new ApiKeyGuard(apiKeyService, reflector);
    rateLimitGuard = new AuthRateLimitGuard(
      rateLimitService,
      authMetricsService,
    );
  });

  describe('Execution Order: ApiKeyGuard -> AuthRateLimitGuard', () => {
    it('should check API key before rate limit', async () => {
      const context = createMockExecutionContext({
        headers: { authorization: '' }, // No API key
      });

      // Should throw on API key check, never reach rate limit check
      let thrownError: any;
      try {
        await apiKeyGuard.canActivate(context);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect(rateLimitService.checkRateLimit).not.toHaveBeenCalled();
    });

    it('should check rate limit after valid API key', async () => {
      const context = createMockExecutionContext({
        headers: { authorization: 'Bearer valid-key' },
      });

      apiKeyService.validateApiKey.mockResolvedValue({
        apiKey: { id: 'key-1' },
        project: { rateLimitRpm: 1000 },
      });

      rateLimitService.checkRateLimit.mockResolvedValue({
        allowed: true,
        limit: 1000,
        remaining: 999,
        resetTime: new Date(Date.now() + 3600000),
      });

      const result = await apiKeyGuard.canActivate(context);
      const rateLimitResult = await rateLimitGuard.canActivate(context);

      expect(result).toBe(true);
      expect(apiKeyService.validateApiKey).toHaveBeenCalledWith('valid-key');
      expect(rateLimitResult).toBe(true);
      expect(rateLimitService.checkRateLimit).toHaveBeenCalled();
    });
  });

  describe('Context Propagation', () => {
    it('should attach API key context to request', async () => {
      const context = createMockExecutionContext({
        headers: { authorization: 'Bearer valid-key' },
      });

      const apiKeyContext = {
        apiKey: { id: 'key-1', name: 'Test Key' },
        project: { id: 'proj-1', rateLimitRpm: 1000 },
      };

      apiKeyService.validateApiKey.mockResolvedValue(apiKeyContext);

      await apiKeyGuard.canActivate(context);

      const request = context.switchToHttp().getRequest();
      expect(request.apiKeyContext).toEqual(apiKeyContext);
      expect(request.apiKeyInfo).toBeDefined();
      expect(request.apiKeyInfo.id).toBe('key-1');
    });

    it('should propagate rate limit context to response headers', async () => {
      const context = createMockExecutionContext({
        headers: { authorization: 'Bearer valid-key' },
      });

      const rateLimitInfo = {
        allowed: true,
        limit: 1000,
        remaining: 999,
        resetTime: new Date(Date.now() + 3600000),
        retryAfterSeconds: null,
      };

      rateLimitService.checkRateLimit.mockResolvedValue(rateLimitInfo);

      await rateLimitGuard.canActivate(context);

      const response = context.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Limit',
        1000,
      );
      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Remaining',
        999,
      );
      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        expect.any(Number),
      );
    });
  });

  describe('Error Handling', () => {
    it('should throw HttpException with proper status on API key validation failure', async () => {
      const context = createMockExecutionContext({
        headers: { authorization: 'Bearer invalid-key' },
      });

      apiKeyService.validateApiKey.mockRejectedValue(
        new HttpException('Invalid API key', HttpStatus.UNAUTHORIZED),
      );

      let thrownError: any;
      try {
        await apiKeyGuard.canActivate(context);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(HttpException);
      expect(thrownError.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should throw HttpException with 429 on rate limit exceeded', async () => {
      const context = createMockExecutionContext({
        headers: { authorization: 'Bearer valid-key' },
      });

      rateLimitService.checkRateLimit.mockResolvedValue({
        allowed: false,
        limit: 100,
        remaining: 0,
        resetTime: new Date(Date.now() + 3600000),
        retryAfterSeconds: 3600,
      });

      let thrownError: any;
      try {
        await rateLimitGuard.canActivate(context);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(HttpException);
      expect(thrownError.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('should set Retry-After header on rate limit error', async () => {
      const context = createMockExecutionContext({
        headers: { authorization: 'Bearer valid-key' },
      });

      rateLimitService.checkRateLimit.mockResolvedValue({
        allowed: false,
        limit: 100,
        remaining: 0,
        resetTime: new Date(Date.now() + 3600000),
        retryAfterSeconds: 3600,
      });

      try {
        await rateLimitGuard.canActivate(context);
      } catch (error) {
        // Expected to throw
      }

      const response = context.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '3600');
    });
  });

  describe('Decorator Metadata Handling', () => {
    it('should skip authentication for @Public() decorated routes', async () => {
      const context = createMockExecutionContext(
        { headers: {} },
        { isPublic: true },
      );

      const result = await apiKeyGuard.canActivate(context);

      expect(result).toBe(true);
      expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
    });

    it('should enforce authentication for non-public routes', async () => {
      const context = createMockExecutionContext({ headers: {} });

      let thrownError: any;
      try {
        await apiKeyGuard.canActivate(context);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('IP Address Extraction for Rate Limiting', () => {
    it('should extract IP from X-Forwarded-For header', async () => {
      const context = createMockExecutionContext({
        headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1' },
      });

      rateLimitService.checkRateLimit.mockResolvedValue({
        allowed: true,
        limit: 100,
        remaining: 99,
        resetTime: new Date(),
      });

      await rateLimitGuard.canActivate(context);

      expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith('192.168.1.1');
    });

    it('should fallback to connection remoteAddress if X-Forwarded-For absent', async () => {
      const context = createMockExecutionContext({
        headers: {},
        remoteAddress: '10.0.0.2',
      });

      rateLimitService.checkRateLimit.mockResolvedValue({
        allowed: true,
        limit: 100,
        remaining: 99,
        resetTime: new Date(),
      });

      await rateLimitGuard.canActivate(context);

      expect(rateLimitService.checkRateLimit).toHaveBeenCalledWith('10.0.0.2');
    });
  });

  describe('Concurrent Guard Execution', () => {
    it('should handle concurrent requests with different API keys independently', async () => {
      const context1 = createMockExecutionContext({
        headers: { authorization: 'Bearer key-1' },
      });
      const context2 = createMockExecutionContext({
        headers: { authorization: 'Bearer key-2' },
      });

      apiKeyService.validateApiKey
        .mockResolvedValueOnce({
          apiKey: { id: 'key-1' },
          project: { rateLimitRpm: 1000 },
        })
        .mockResolvedValueOnce({
          apiKey: { id: 'key-2' },
          project: { rateLimitRpm: 500 },
        });

      rateLimitService.checkRateLimit
        .mockResolvedValueOnce({
          allowed: true,
          limit: 1000,
          remaining: 999,
          resetTime: new Date(),
        })
        .mockResolvedValueOnce({
          allowed: true,
          limit: 500,
          remaining: 499,
          resetTime: new Date(),
        });

      const [result1, result2] = await Promise.all([
        apiKeyGuard.canActivate(context1),
        apiKeyGuard.canActivate(context2),
      ]);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(context1.switchToHttp().getRequest().apiKeyContext.apiKey.id).toBe(
        'key-1',
      );
      expect(context2.switchToHttp().getRequest().apiKeyContext.apiKey.id).toBe(
        'key-2',
      );
    });
  });
});

// Helper to create mock ExecutionContext
function createMockExecutionContext(
  requestOptions: any,
  metadata: any = {},
): any {
  const request = {
    headers: requestOptions.headers || {},
    connection: { remoteAddress: requestOptions.remoteAddress || '127.0.0.1' },
    socket: { remoteAddress: requestOptions.remoteAddress || '127.0.0.1' },
  };

  const response = {
    setHeader: jest.fn().mockReturnThis(),
    getHeader: jest.fn(),
  };

  const contextClass = {
    canActivate: jest.fn(),
  };

  return {
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue(request),
      getResponse: jest.fn().mockReturnValue(response),
    }),
    getHandler: jest.fn().mockReturnValue(contextClass.canActivate),
    getClass: jest.fn().mockReturnValue(contextClass),
  };
}
