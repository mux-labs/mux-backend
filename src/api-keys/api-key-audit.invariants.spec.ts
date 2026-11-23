import { Logger } from '@nestjs/common';
import {
  ApiKeyAuditAction,
  ApiKeyAuditReason,
  ApiKeyAuditService,
} from './api-key-audit.service';

/**
 * Regression coverage for the audit invariants (#1323): rejection reasons are
 * stable, distinct machine signals that never carry key material.
 */
describe('API key audit invariants', () => {
  const service = () => new ApiKeyAuditService({ incrementCounter: jest.fn() } as any);

  it('keeps rejection reasons stable, distinct and non-prose', () => {
    expect(ApiKeyAuditReason).toEqual({
      MISSING: 'MISSING',
      MALFORMED: 'MALFORMED',
      UNKNOWN: 'UNKNOWN',
      REVOKED: 'REVOKED',
      EXPIRED: 'EXPIRED',
      SUSPENDED: 'SUSPENDED',
    });

    const reasons = Object.values(ApiKeyAuditReason);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) {
      expect(reason).toMatch(/^[A-Z_]+$/);
      expect(reason).not.toMatch(/secret|key|token|expired key|revoked key/i);
    }
  });

  it('records a revoked, expired and malformed key as different reasons without key material', () => {
    const audit = service();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const presentedKey = 'sk_live_SUPER_SECRET_KEY_MATERIAL_123456';
    const fingerprint = audit.fingerprint(presentedKey)!;

    const stored = [
      ApiKeyAuditReason.REVOKED,
      ApiKeyAuditReason.EXPIRED,
      ApiKeyAuditReason.MALFORMED,
    ].map((reason) =>
      audit.record({
        action: ApiKeyAuditAction.REJECTED,
        reason,
        fingerprint,
        correlationId: 'corr-1',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );

    expect(stored.map((event) => event.reason)).toEqual([
      'REVOKED',
      'EXPIRED',
      'MALFORMED',
    ]);
    expect(new Set(stored.map((event) => event.reason)).size).toBe(3);
    for (const event of stored) {
      expect(JSON.stringify(event)).not.toContain(presentedKey);
      expect(event.fingerprint).toBe(fingerprint);
    }
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain(presentedKey);
    }
    log.mockRestore();
  });
});
