import {
  API_KEY_FINGERPRINT_LENGTH,
  ApiKeyAuditAction,
  ApiKeyAuditReason,
  ApiKeyAuditService,
  MAX_AUDIT_BUFFER_SIZE,
  MAX_AUDIT_FIELD_LENGTH,
} from './api-key-audit.service';
import { MetricsService } from '../common/metrics/metrics.service';

const CORRELATION_ID = 'corr-1';

describe('ApiKeyAuditService', () => {
  let audit: ApiKeyAuditService;
  let metrics: jest.Mocked<Pick<MetricsService, 'incrementCounter'>>;

  beforeEach(() => {
    metrics = { incrementCounter: jest.fn() };
    audit = new ApiKeyAuditService(metrics as unknown as MetricsService);
  });

  describe('fingerprint()', () => {
    it('returns a truncated sha256 hex digest', () => {
      const fingerprint = audit.fingerprint('mux_live_abc');

      expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(fingerprint).toHaveLength(API_KEY_FINGERPRINT_LENGTH);
    });

    it('is deterministic for the same key and differs across keys', () => {
      expect(audit.fingerprint('key-a')).toBe(audit.fingerprint('key-a'));
      expect(audit.fingerprint('key-a')).not.toBe(audit.fingerprint('key-b'));
    });

    it('never reveals the key material', () => {
      const secret = 'mux_live_this-is-the-secret-part';
      expect(audit.fingerprint(secret)).not.toContain('secret-part');
    });

    it('returns undefined for an absent or empty key', () => {
      expect(audit.fingerprint(undefined)).toBeUndefined();
      expect(audit.fingerprint(null)).toBeUndefined();
      expect(audit.fingerprint('')).toBeUndefined();
    });
  });

  describe('sameKey()', () => {
    it('matches equal fingerprints and rejects different or absent ones', () => {
      const fingerprint = audit.fingerprint('mux_live_abc');

      expect(
        audit.sameKey(fingerprint, audit.fingerprint('mux_live_abc')),
      ).toBe(true);
      expect(
        audit.sameKey(fingerprint, audit.fingerprint('mux_live_xyz')),
      ).toBe(false);
      expect(audit.sameKey(undefined, fingerprint)).toBe(false);
      expect(audit.sameKey(fingerprint, undefined)).toBe(false);
      // Different lengths must not throw inside timingSafeEqual.
      expect(audit.sameKey('abc', 'abcdef')).toBe(false);
    });
  });
  describe('record()', () => {
    it('stores and returns the sanitized event with an ISO timestamp', () => {
      const event = audit.record({
        action: ApiKeyAuditAction.VALIDATED,
        apiKeyId: 'key-1',
        developerId: 'dev-1',
        projectId: 'proj-1',
        route: 'GET /wallets/protected',
        ip: '127.0.0.1',
        correlationId: CORRELATION_ID,
      });

      expect(event).toMatchObject({
        action: ApiKeyAuditAction.VALIDATED,
        apiKeyId: 'key-1',
        correlationId: CORRELATION_ID,
      });
      expect(new Date(event.at).toISOString()).toBe(event.at);
      expect(audit.recent()).toEqual([event]);
    });

    it('strips control characters (log-injection defense) but keeps the route readable', () => {
      const event = audit.record({
        action: ApiKeyAuditAction.REJECTED,
        route: 'GET /x\napikey.audit action=API_KEY_VALIDATED',
        correlationId: CORRELATION_ID,
      });

      // The injected newline is gone, so it cannot forge a second log line...
      expect(event.route).not.toContain('\n');
      // ...while the single space that separates method from path survives.
      expect(event.route).toBe('GET /x_apikey.audit action_API_KEY_VALIDATED');
    });

    it('neutralizes carriage returns and tabs the same way', () => {
      const event = audit.record({
        action: ApiKeyAuditAction.REJECTED,
        route: 'GET /x\r\n\tapikey.audit',
        correlationId: CORRELATION_ID,
      });

      expect(event.route).not.toMatch(/[\r\n\t]/);
    });

    it('bounds every field to the maximum length', () => {
      const event = audit.record({
        action: ApiKeyAuditAction.VALIDATED,
        correlationId: CORRELATION_ID,
        apiKeyId: 'k'.repeat(500),
      });

      expect(event.apiKeyId).toHaveLength(MAX_AUDIT_FIELD_LENGTH);
    });

    it('increments an ops-safe counter per action and per reason', () => {
      audit.record({
        action: ApiKeyAuditAction.REJECTED,
        reason: ApiKeyAuditReason.EXPIRED,
        correlationId: CORRELATION_ID,
      });

      const names = metrics.incrementCounter.mock.calls.map((call) => call[0]);
      expect(names).toContain('apikey_audit_api_key_rejected');
      expect(names).toContain('apikey_audit_reason_expired');
    });

    it('still records the event when the metrics sink throws', () => {
      metrics.incrementCounter.mockImplementation(() => {
        throw new Error('metrics down');
      });

      const event = audit.record({
        action: ApiKeyAuditAction.VALIDATED,
        correlationId: CORRELATION_ID,
      });

      expect(event.correlationId).toBe(CORRELATION_ID);
      expect(audit.recent()).toHaveLength(1);
    });
  });
  describe('buffer bounds', () => {
    it('is bounded so a key spray cannot grow memory without limit', () => {
      for (let i = 0; i < MAX_AUDIT_BUFFER_SIZE + 25; i += 1) {
        audit.record({
          action: ApiKeyAuditAction.REJECTED,
          reason: ApiKeyAuditReason.UNKNOWN,
          correlationId: `${CORRELATION_ID}-${i}`,
        });
      }

      const events = audit.recent(MAX_AUDIT_BUFFER_SIZE * 2);
      expect(events).toHaveLength(MAX_AUDIT_BUFFER_SIZE);
      // The oldest events were evicted; the newest is retained.
      expect(events[events.length - 1].correlationId).toBe(
        `${CORRELATION_ID}-${MAX_AUDIT_BUFFER_SIZE + 24}`,
      );
    });

    it('returns events newest-last and honours the limit', () => {
      audit.record({ action: ApiKeyAuditAction.VALIDATED, correlationId: 'a' });
      audit.record({ action: ApiKeyAuditAction.VALIDATED, correlationId: 'b' });

      expect(audit.recent(1).map((e) => e.correlationId)).toEqual(['b']);
      expect(audit.recent()).toHaveLength(2);
    });

    it('returns an empty list for a non-positive or fractional limit', () => {
      audit.record({ action: ApiKeyAuditAction.VALIDATED, correlationId: 'a' });

      expect(audit.recent(0)).toEqual([]);
      expect(audit.recent(-1)).toEqual([]);
      expect(audit.recent(1.5)).toEqual([]);
    });

    it('clear() empties the buffer', () => {
      audit.record({ action: ApiKeyAuditAction.VALIDATED, correlationId: 'a' });
      audit.clear();

      expect(audit.recent()).toEqual([]);
    });
  });
});
