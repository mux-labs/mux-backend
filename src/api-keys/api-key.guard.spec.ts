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
import { ApiKeyContext, ApiKeyStatus } from './domain/api-key.model';

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
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: any) => {
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

  // -------------------------------------------------------------------------
  // #956 API key audit log
  // -------------------------------------------------------------------------

  describe('API key audit log', () => {
    let audit: ApiKeyAuditService;

    const contextFor = (req: any) => ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    });

    beforeEach(() => {
      audit = new ApiKeyAuditService(new MetricsService());
      guard = new ApiKeyGuard(
        mockApiKeyService as ApiKeyService,
        reflector,
        audit,
      );
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      jest.spyOn(reflector, 'get').mockReturnValue(true);
    });

    it('records a validation event with ids, route and correlation id', async () => {
      const req: any = {
        headers: { authorization: 'ApiKey mux_test_abc' },
        path: '/wallets/protected',
        method: 'GET',
        ip: '127.0.0.1',
      };

      await guard.canActivate(contextFor(req));

      const events = audit.recent();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe(ApiKeyAuditAction.VALIDATED);
      expect(events[0].apiKeyId).toBe('key-id');
      expect(events[0].developerId).toBe('dev-id');
      expect(events[0].projectId).toBe('proj-id');
      expect(events[0].route).toBe('GET /wallets/protected');
      expect(events[0].ip).toBe('127.0.0.1');
      expect(events[0].correlationId).toEqual(expect.any(String));
    });

    it('never records the presented key material in the audit event', async () => {
      const req: any = {
        headers: { authorization: 'ApiKey mux_live_supersecretvalue123' },
        path: '/wallets/protected',
        method: 'GET',
        ip: '127.0.0.1',
      };

      await guard.canActivate(contextFor(req));

      const [event] = audit.recent();
      expect(event.fingerprint).toHaveLength(12);
      expect(JSON.stringify(event)).not.toContain('supersecretvalue123');
    });

    it('audits a missing key as REJECTED/MISSING with no fingerprint', async () => {
      const req: any = { headers: {}, path: '/x', method: 'GET' };

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
        UnauthorizedException,
      );

      const [event] = audit.recent();
      expect(event.action).toBe(ApiKeyAuditAction.REJECTED);
      expect(event.reason).toBe(ApiKeyAuditReason.MISSING);
      expect(event.fingerprint).toBeUndefined();
    });

    it('audits a malformed Authorization header as REJECTED/MALFORMED', async () => {
      const req: any = {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
        path: '/x',
        method: 'GET',
      };

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
        'Invalid API key format',
      );

      const [event] = audit.recent();
      expect(event.reason).toBe(ApiKeyAuditReason.MALFORMED);
    });

    it('audits an unknown key as REJECTED/UNKNOWN and attaches no context', async () => {
      (mockApiKeyService.validateApiKey as jest.Mock).mockResolvedValue(null);
      const req: any = {
        headers: { authorization: 'ApiKey mux_test_unknown' },
        path: '/x',
        method: 'GET',
      };

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
        UnauthorizedException,
      );

      const [event] = audit.recent();
      expect(event.reason).toBe(ApiKeyAuditReason.UNKNOWN);
      expect(event.apiKeyId).toBeUndefined();
      expect(req.apiKey).toBeUndefined();
    });

    it('audits a key-store outage as VALIDATION_UNAVAILABLE and fails closed with 503', async () => {
      (mockApiKeyService.validateApiKey as jest.Mock).mockRejectedValue(
        new Error('DB is down'),
      );
      const req: any = {
        headers: { authorization: 'ApiKey mux_test_abc' },
        path: '/x',
        method: 'GET',
      };

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
        'API key validation service unavailable',
      );

      const [event] = audit.recent();
      expect(event.action).toBe(
        ApiKeyAuditAction.VALIDATION_UNAVAILABLE,
      );
      // Fail closed: nothing is attached to the request on an outage.
      expect(req.apiKey).toBeUndefined();
    });

    it('preserves a 401 thrown by the key service instead of masking it as 503', async () => {
      (mockApiKeyService.validateApiKey as jest.Mock).mockRejectedValue(
        new UnauthorizedException('API key has expired'),
      );
      const req: any = {
        headers: { authorization: 'ApiKey mux_test_expired' },
        path: '/x',
        method: 'GET',
      };

      await expect(guard.canActivate(contextFor(req))).rejects.toThrow(
        'API key has expired',
      );
    });

    it('keeps the request outcome unchanged when the audit sink throws', async () => {
      jest
        .spyOn(audit, 'record')
        .mockImplementation(() => {
          throw new Error('audit sink down');
        });
      const req: any = {
        headers: { authorization: 'ApiKey mux_test_abc' },
        path: '/wallets/protected',
        method: 'GET',
        ip: '127.0.0.1',
      };

      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
      expect(req.apiKey).toBeDefined();
    });

    it('strips a query string from the audited route', async () => {
      const req: any = {
        headers: { authorization: 'ApiKey mux_test_abc' },
        path: '/wallets/protected?secret=leak',
        method: 'GET',
      };

      await guard.canActivate(contextFor(req));

      expect(audit.recent()[0].route).toBe('GET /wallets/protected');
    });
  });
});
