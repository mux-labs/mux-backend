import { Logger } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import {
  ApiKeyAuditAction,
  ApiKeyAuditReason,
} from './api-key-audit.service';

describe('ApiKeyGuard.auditDecision', () => {
  function buildGuard(audit?: any) {
    const apiKeyService = {} as any;
    const reflector = { getAllAndOverride: jest.fn() } as any;
    const guard = new ApiKeyGuard(apiKeyService, reflector, audit);
    return guard;
  }

  it('records an audit decision through the sink with a fingerprint derived from the key, never the key itself', async () => {
    const fingerprint = jest.fn().mockReturnValue('fp-1234567890');
    const record = jest.fn().mockResolvedValue(undefined);
    const guard = buildGuard({ fingerprint, record });

    await (guard as any).auditDecision({
      action: ApiKeyAuditAction.REJECTED,
      reason: ApiKeyAuditReason.MISSING,
      apiKey: 'mux_test_secret-value',
      request: {
        method: 'GET',
        path: '/v1/resource',
        ip: '127.0.0.1',
      },
      correlationId: 'corr-1',
      apiKeyId: 'key-1',
      developerId: 'dev-1',
      projectId: 'proj-1',
    });

    expect(fingerprint).toHaveBeenCalledWith('mux_test_secret-value');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ApiKeyAuditAction.REJECTED,
        reason: ApiKeyAuditReason.MISSING,
        fingerprint: 'fp-1234567890',
        apiKeyId: 'key-1',
        developerId: 'dev-1',
        projectId: 'proj-1',
        route: 'GET /v1/resource',
        ip: '127.0.0.1',
        correlationId: 'corr-1',
      }),
    );

    const recorded = record.mock.calls[0][0];
    expect(JSON.stringify(recorded)).not.toContain('mux_test_secret-value');
    expect(recorded).not.toHaveProperty('apiKey');
  });

  it('never throws and never re-throws when the audit sink rejects, and does not leak the presented key into the logged error', async () => {
    const presentedKey = 'mux_live_super-secret-key';
    const fingerprint = jest.fn().mockReturnValue('fp-redacted');
    const record = jest
      .fn()
      .mockRejectedValue(new Error(`sink failed for ${presentedKey}`));
    const guard = buildGuard({ fingerprint, record });
    const warnSpy = jest.spyOn((guard as any).logger, 'warn').mockImplementation();

    await expect(
      (guard as any).auditDecision({
        action: ApiKeyAuditAction.REJECTED,
        reason: ApiKeyAuditReason.UNKNOWN,
        apiKey: presentedKey,
        request: {
          method: 'POST',
          originalUrl: '/v1/keys?secret=1',
          socket: { remoteAddress: '10.0.0.1' },
        },
        correlationId: 'corr-2',
      }),
    ).resolves.toBeUndefined();

    expect(record).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = String(warnSpy.mock.calls[0][0]);
    expect(warning).toContain('API key audit write failed');
    expect(warning).not.toContain(presentedKey);

    warnSpy.mockRestore();
  });

  it('awaits the audit sink so ordering is deterministic', async () => {
    const events: string[] = [];
    const record = jest.fn().mockImplementation(async () => {
      events.push('record-start');
      await Promise.resolve();
      events.push('record-end');
    });
    const guard = buildGuard({
      fingerprint: jest.fn().mockReturnValue('fp-order'),
      record,
    });

    const promise = (guard as any).auditDecision({
      action: ApiKeyAuditAction.VALIDATED,
      apiKey: 'mux_test_ordering',
      request: { method: 'GET', path: '/v1/order' },
      correlationId: 'corr-3',
    });
    events.push('after-call');
    await promise;
    events.push('after-await');

    expect(events).toEqual([
      'record-start',
      'after-call',
      'record-end',
      'after-await',
    ]);
  });
});
