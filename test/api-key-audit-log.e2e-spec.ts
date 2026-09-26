/**
 * API key audit log — e2e tests (#956)
 *
 * WHY THIS EXISTS
 * Every API key authentication decision is a security event: a key that starts
 * working, stops working, or is used in a spray is something an operator has to
 * be able to reconstruct. These tests assert the three properties that make the
 * trail usable and safe:
 *
 *   1. Every decision (allow, reject, dependency outage) is recorded with a
 *      stable action/reason code, a correlation id, and resolved ids.
 *   2. Key material never reaches the audit trail — only a truncated SHA-256
 *      fingerprint does.
 *   3. The audit sink never changes the authentication outcome, and the buffer
 *      is bounded so a key spray cannot grow it without limit.
 *
 * Runs fully offline: the guard and the audit sink are real, only the key store
 * is a stub.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import {
  ApiKeyAuditAction,
  ApiKeyAuditReason,
  ApiKeyAuditService,
  MAX_AUDIT_BUFFER_SIZE,
} from '../src/api-keys/api-key-audit.service';
import { MetricsService } from '../src/common/metrics/metrics.service';

const SECRET_KEY = 'mux_live_thisKeyMustNeverBeAudited1234';

describe('API key audit log (e2e)', () => {
  let module: TestingModule;
  let guard: ApiKeyGuard;
  let audit: ApiKeyAuditService;
  let keyStore: { validateApiKey: jest.Mock };

  /** A real handler/class pair: `Reflector` needs functions to read metadata from. */
  class TestController {
    handler = (): void => undefined;
  }
  const handler = new TestController().handler;

  const request = (headers: Record<string, string>) => {
    const req: Record<string, unknown> = {
      headers,
      path: '/wallets/protected',
      method: 'GET',
      ip: '203.0.113.7',
    };
    return {
      req,
      context: {
        getHandler: () => handler,
        getClass: () => TestController,
        switchToHttp: () => ({ getRequest: () => req }),
      },
    };
  };

  beforeEach(async () => {
    keyStore = {
      validateApiKey: jest.fn().mockResolvedValue({
        apiKey: { id: 'key-1' },
        project: { id: 'proj-1', name: 'Mux' },
        developer: { id: 'dev-1', email: 'dev@example.com' },
      }),
    };

    module = await Test.createTestingModule({
      providers: [
        ApiKeyGuard,
        ApiKeyAuditService,
        MetricsService,
        Reflector,
        { provide: ApiKeyService, useValue: keyStore },
      ],
    }).compile();

    guard = module.get(ApiKeyGuard);
    audit = module.get(ApiKeyAuditService);
  });

  afterEach(async () => {
    await module.close();
  });
  it('records an accepted key with resolved ids, route, ip and correlation id', async () => {
    const { req, context } = request({
      authorization: `Bearer ${SECRET_KEY}`,
      'x-request-id': 'corr-accept',
    });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(req.apiKey).toBeDefined();

    const [event] = audit.recent();
    expect(event.action).toBe(ApiKeyAuditAction.VALIDATED);
    expect(event.apiKeyId).toBe('key-1');
    expect(event.developerId).toBe('dev-1');
    expect(event.projectId).toBe('proj-1');
    expect(event.route).toBe('GET /wallets/protected');
    expect(event.ip).toBe('203.0.113.7');
    expect(event.correlationId).toBe('corr-accept');
  });

  it('never persists the presented key, only a 12-char fingerprint', async () => {
    const { context } = request({ authorization: `Bearer ${SECRET_KEY}` });

    await guard.canActivate(context as never);

    const [event] = audit.recent();
    expect(event.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(audit.recent())).not.toContain(
      'thisKeyMustNeverBeAudited1234',
    );
    expect(JSON.stringify(event)).not.toContain(SECRET_KEY);
  });

  it('records a rejected key with a stable reason and attaches no context', async () => {
    keyStore.validateApiKey.mockResolvedValue(null);
    const { req, context } = request({ authorization: 'Bearer mux_test_nope' });

    await expect(guard.canActivate(context as never)).rejects.toThrow(
      UnauthorizedException,
    );

    const [event] = audit.recent();
    expect(event.action).toBe(ApiKeyAuditAction.REJECTED);
    expect(event.reason).toBe(ApiKeyAuditReason.UNKNOWN);
    expect(req.apiKey).toBeUndefined();
  });

  it('records a key-store outage distinctly and fails closed with 503', async () => {
    keyStore.validateApiKey.mockRejectedValue(new Error('DB is down'));
    const { req, context } = request({ authorization: `Bearer ${SECRET_KEY}` });

    await expect(guard.canActivate(context as never)).rejects.toThrow(
      ServiceUnavailableException,
    );

    const [event] = audit.recent();
    expect(event.action).toBe(ApiKeyAuditAction.VALIDATION_UNAVAILABLE);
    expect(req.apiKey).toBeUndefined();
  });

  it('preserves an upstream 401 rather than masking it as an outage', async () => {
    keyStore.validateApiKey.mockRejectedValue(
      new UnauthorizedException('API key has expired'),
    );
    const { context } = request({ authorization: `Bearer ${SECRET_KEY}` });

    await expect(guard.canActivate(context as never)).rejects.toThrow(
      'API key has expired',
    );
  });

  it('keeps the request outcome unchanged when the audit sink throws', async () => {
    jest.spyOn(audit, 'record').mockImplementation(() => {
      throw new Error('audit sink down');
    });
    const { req, context } = request({ authorization: `Bearer ${SECRET_KEY}` });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(req.apiKey).toBeDefined();
  });

  it('bounds the buffer so a rejected-key spray cannot exhaust memory', async () => {
    keyStore.validateApiKey.mockResolvedValue(null);

    for (let i = 0; i < MAX_AUDIT_BUFFER_SIZE + 50; i += 1) {
      const { context } = request({ authorization: `Bearer mux_test_${i}` });
      await expect(guard.canActivate(context as never)).rejects.toThrow();
    }

    expect(audit.recent(MAX_AUDIT_BUFFER_SIZE * 2)).toHaveLength(
      MAX_AUDIT_BUFFER_SIZE,
    );
  });
});
