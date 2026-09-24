import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard, REQUIRE_API_KEY, IS_PUBLIC } from './api-key.guard';
import { ApiKeyService } from './api-key.service';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let mockApiKeyService: Partial<ApiKeyService>;
  let reflector: Reflector;

  beforeEach(() => {
    mockApiKeyService = {
      validateApiKey: jest.fn(async (key: string) => ({
        apiKey: { id: 'key-id' },
        project: { id: 'proj-id', rateLimitRpm: 10 },
        developer: { id: 'dev-id' },
      })),
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
    expect(req.apiKeyContext.developerId).toBe('dev-id');
    expect(req.apiKeyContext.developerId).not.toBe(req.body.developerId);
  });

  it('rejects payment wallet linkage when the API key is revoked (deny-by-default)', async () => {
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
      path: '/payments/wallets/link',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      body: { walletId: 'wallet-1' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(req.apiKeyContext).toBeUndefined();
  });

  it('denies by default for a non-allowlisted route without IS_PUBLIC metadata', async () => {
    // No IS_PUBLIC metadata and no REQUIRE_API_KEY metadata: the guard must
    // still deny by default rather than silently allowing the request.
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);

    const req: any = {
      headers: { 'user-agent': 'jest' },
      path: '/admin/privileged',
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

  it('allows only explicitly allowlisted public endpoints without credentials', async () => {
    // IS_PUBLIC is the explicit allowlist marker; only routes decorated with it
    // bypass API key auth. Everything else is denied by default.
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: any) => {
      if (key === IS_PUBLIC) {
        return true;
      }
      return undefined;
    });

    const req: any = {
      headers: { 'user-agent': 'jest' },
      path: '/health',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyContext).toBeUndefined();
  });
});
