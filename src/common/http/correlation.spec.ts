import {
  buildWebhookCorrelationHeaders,
  getRequestId,
  newCorrelationId,
  WEBHOOK_REQUEST_ID_FIELD,
  WEBHOOK_REQUEST_ID_HEADER,
  withWebhookCorrelation,
} from './correlation';
import {
  MAX_REQUEST_ID_LENGTH,
  resolveRequestId,
} from '../interceptors/request-id.interceptor';

/**
 * Unit tests for correlation-id propagation (#927).
 *
 * Invariants under test:
 *  - a well-formed inbound id is reused so a client can trace its own request;
 *  - a hostile/injected id is replaced, never logged or forwarded as-is;
 *  - the id reaches outbound webhooks in a header and in the payload;
 *  - background work gets a server-generated id.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('correlation (#927)', () => {
  describe('getRequestId', () => {
    it('reuses a well-formed inbound id so the client can trace it', () => {
      const requestId = getRequestId({
        headers: { 'x-request-id': 'req-abc-123' },
      });
      expect(requestId).toBe('req-abc-123');
    });

    it('prefers the id already stamped on the request', () => {
      const requestId = getRequestId({
        requestId: 'stamped-id',
        headers: { 'x-request-id': 'header-id' },
      });
      expect(requestId).toBe('stamped-id');
    });

    it('generates an id when the client supplied none', () => {
      expect(getRequestId({ headers: {} })).toMatch(UUID_RE);
    });

    it('replaces a log-injection attempt instead of forwarding it', () => {
      const requestId = getRequestId({
        headers: { 'x-request-id': 'abc\nINFO forged log line' },
      });
      expect(requestId).not.toContain('\n');
      expect(requestId).toMatch(UUID_RE);
    });

    it('replaces an over-long id so logs cannot be amplified', () => {
      const requestId = getRequestId({
        headers: { 'x-request-id': 'a'.repeat(MAX_REQUEST_ID_LENGTH + 1) },
      });
      expect(requestId).toMatch(UUID_RE);
    });

    it('re-validates an id attached directly to the request object', () => {
      // A handler could set `request.requestId` to anything; logs must stay
      // injection-proof, so the value is re-validated rather than trusted.
      const requestId = getRequestId({
        requestId: 'bad id with spaces',
        headers: {},
      });
      expect(requestId).toMatch(UUID_RE);
    });

    it('handles a missing request without throwing', () => {
      expect(getRequestId(undefined)).toMatch(UUID_RE);
      expect(getRequestId(null)).toMatch(UUID_RE);
    });

    it('reads the first value of a repeated header', () => {
      const requestId = getRequestId({
        headers: { 'x-request-id': ['first-id', 'second-id'] },
      });
      expect(requestId).toBe('first-id');
    });
  });

  describe('newCorrelationId', () => {
    it('generates a server-side id with the job prefix', () => {
      expect(newCorrelationId('poll-pending')).toMatch(
        /^poll-pending-[0-9a-f-]{36}$/,
      );
    });
  });

  describe('buildWebhookCorrelationHeaders', () => {
    it('forwards the originating request id to the subscriber', () => {
      const headers = buildWebhookCorrelationHeaders({
        requestId: 'req-abc-123',
      });
      expect(headers[WEBHOOK_REQUEST_ID_HEADER]).toBe('req-abc-123');
    });

    it('generates an id for a background-originated event', () => {
      const headers = buildWebhookCorrelationHeaders({
        jobPrefix: 'poll-pending',
      });
      expect(headers[WEBHOOK_REQUEST_ID_HEADER]).toMatch(
        /^poll-pending-[0-9a-f-]{36}$/,
      );
    });

    it('sanitizes a hostile request id before it leaves the process', () => {
      const headers = buildWebhookCorrelationHeaders({
        requestId: 'evil\r\nSet-Cookie: a=b',
      });
      expect(headers[WEBHOOK_REQUEST_ID_HEADER]).toMatch(UUID_RE);
    });

    it('never includes signing or credential material', () => {
      const headers = buildWebhookCorrelationHeaders({ requestId: 'req-1' });
      expect(Object.keys(headers)).toEqual([WEBHOOK_REQUEST_ID_HEADER]);
    });
  });

  describe('withWebhookCorrelation', () => {
    it('adds requestId to the payload without dropping caller fields', () => {
      const payload = withWebhookCorrelation(
        { type: 'wallet.created', data: { id: 'w-1' } },
        { requestId: 'req-abc-123' },
      );

      expect(payload.type).toBe('wallet.created');
      expect(payload.data).toEqual({ id: 'w-1' });
      expect(payload[WEBHOOK_REQUEST_ID_FIELD]).toBe('req-abc-123');
    });

    it('agrees with the header builder so header and payload never diverge', () => {
      const headers = buildWebhookCorrelationHeaders({
        requestId: 'req-abc-123',
      });
      const payload = withWebhookCorrelation(
        { type: 'wallet.created' },
        { requestId: 'req-abc-123' },
      );

      expect(payload[WEBHOOK_REQUEST_ID_FIELD]).toBe(
        headers[WEBHOOK_REQUEST_ID_HEADER],
      );
    });

    it('does not mutate the caller payload', () => {
      const original = { type: 'wallet.created' };
      withWebhookCorrelation(original, { requestId: 'req-1' });
      expect(original).toEqual({ type: 'wallet.created' });
    });

    it('still produces a traceable payload for a background event', () => {
      const payload = withWebhookCorrelation(
        { type: 'transaction.confirmed' },
        { jobPrefix: 'poll-pending' },
      );
      expect(payload[WEBHOOK_REQUEST_ID_FIELD]).toMatch(
        /^poll-pending-[0-9a-f-]{36}$/,
      );
    });
  });

  it('resolveRequestId remains the single source of truth', () => {
    // Guards the refactor: the middleware no longer re-implements the rules.
    expect(resolveRequestId('req-1')).toBe('req-1');
    expect(resolveRequestId('has space')).toMatch(UUID_RE);
  });
});
