import { Reflector } from '@nestjs/core';
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
        project: { id: 'proj-id' },
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
      headers: { authorization: 'ApiKey mux_test_abc' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyContext).toBeDefined();
    expect(req.apiKeyInfo).toBeDefined();
  });

  it('maps upstream validation errors to ServiceUnavailableException (503)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    // Make validateApiKey throw a non-Unauthorized error
    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => {
      throw new Error('DB is down');
    });

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
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
});
