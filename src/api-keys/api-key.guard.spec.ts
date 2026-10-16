import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard, REQUIRE_API_KEY, IS_PUBLIC } from './api-key.guard';
import { ApiKeyService } from './api-key.service';
import {
  ApiKeyAuditAction,
  ApiKeyAuditReason,
  ApiKeyAuditService,
} from './api-key-audit.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { ApiKeyContext, ApiKeyErrorCode, ApiKeyStatus } from './domain/api-key.model';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let mockApiKeyService: Partial<ApiKeyService>;
  let reflector: Reflector;

  /**
   * A complete validated-key context. `validateApiKey` returns `ApiKeyInfo`,
   * so the stub must carry the full domain shape (not just an id) — the guard
   * copies `developer.id` into the request context and that identity is
   * authoritative for downstream ownership checks.
   */
  const validatedContext: ApiKeyContext = {
    apiKey: {
      id: 'key-id',
      name: 'test key',
      keyHash: 'hashed',
      keyPrefix: 'mux_test_',
      lastFour: 'abcd',
      projectId: 'proj-id',
      status: ApiKeyStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    project: {
      id: 'proj-id',
      name: 'proj-name',
      environment: 'development',
      developerId: 'dev-id',
      rateLimitRpm: 10,
    },
    developer: { id: 'dev-id', email: 'dev@example.com' },
  };

  beforeEach(() => {
    mockApiKeyService = {
      validateApiKey: jest.fn(async () => validatedContext),
      recordUsage: jest.fn(async () => {}),
    };

    reflector = new Reflector();

    guard = new ApiKeyGuard(mockApiKeyService as ApiKeyService, reflector);
  });

  it('allows when route is public via IS_PUBLIC metadata', async () => {
    // spy on reflector to return true for isPublic
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects when Authorization header missing', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('throws API_KEY_UNAUTHORIZED when no Authorization/X-API-Key header is present', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    };

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ApiKeyErrorCode.UNAUTHORIZED },
    });
  });

  it('throws API_KEY_INVALID_FORMAT when the credential is malformed', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: 'ApiKey not-a-valid-key' } }),
      }),
    };

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ApiKeyErrorCode.INVALID_FORMAT },
    });
  });

  it('skips validation when the route is marked as not requiring an API key', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(false);

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockApiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  it('allows with valid Authorization header and attaches context', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc', 'user-agent': 'jest' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const res: any = {
      statusCode: 200,
      on: jest.fn((event, callback) => {
        if (event === 'finish') {
          callback();
        }
      }),
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyContext).toBeDefined();
    expect(req.apiKeyInfo).toEqual({
      id: 'key-id',
      project: {
        rateLimitRpm: 10,
      },
    });
    expect(mockApiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-id',
      'proj-id',
      'GET /wallets/protected',
      'GET',
      200,
      '127.0.0.1',
      'jest',
      expect.any(Number),
    );
  });

  it('maps upstream validation errors to ServiceUnavailableException (503)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    // Make validateApiKey throw a non-Unauthorized error
    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => {
      throw new Error('DB is down');
    });

    const req: any = {
      headers: {
        authorization: 'ApiKey mux_test_abc',
        'user-agent': 'jest',
      },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow(
      'API key validation service unavailable',
    );
  });

  it('fails closed (503) when the API key store is unavailable during cursor import authz', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    // Simulate a dependency outage (DB/Horizon) surfacing as a non-auth error.
    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => {
      throw new Error('Horizon unavailable');
    });

    const req: any = {
      headers: {
        authorization: 'ApiKey mux_test_abc',
        'user-agent': 'jest',
      },
      path: '/horizon/import/cursor',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      query: { userId: 'attacker-supplied-id' },
      body: { userId: 'attacker-supplied-id' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow(
      'API key validation service unavailable',
    );
    // Deny-by-default: no cursor context is attached on failure.
    expect(req.apiKeyContext).toBeUndefined();
  });

  it('rejects cursor advancement when the API key is revoked (deny-by-default)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => {
      throw new Error('Unauthorized');
    });

    const req: any = {
      headers: {
        authorization: 'ApiKey mux_revoked',
        'user-agent': 'jest',
      },
      path: '/horizon/import/cursor',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(req.apiKeyContext).toBeUndefined();
  });

  it('links payment wallet identity to the authenticated developer (deny-by-default)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    const req: any = {
      headers: {
        authorization: 'ApiKey mux_test_abc',
        'user-agent': 'jest',
      },
      path: '/payments/wallets/link',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      body: { walletId: 'wallet-1', developerId: 'attacker-supplied-id' },
    };

    const res: any = {
      statusCode: 201,
      on: jest.fn((event, callback) => {
        if (event === 'finish') {
          callback();
        }
      }),
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // The authenticated developer identity is the source of truth; client-supplied
    // developerId must not be trusted for the payment wallet linkage.
    expect(req.apiKeyContext).toBeDefined();
    expect(req.apiKeyContext.developer.id).toBe('dev-id');
  });
});
