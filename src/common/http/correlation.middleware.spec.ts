/**
 * Unit tests for the correlation-id logging middleware (#927).
 *
 * The middleware is what makes a request traceable end to end: it resolves the
 * id, sanitizes it, stamps it on the request for every downstream layer, and
 * echoes it back so a caller can quote it in a support request. These tests
 * assert that contract and, critically, that an untrusted header can never
 * reach a log line or a downstream reader.
 */

import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequestLoggingMiddleware } from '../middleware/request-logging.middleware';
import { REQUEST_ID_HEADER } from './correlation';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TestRequest = Request & { requestId?: string };
type TestResponse = Response & {
  headers: Record<string, string>;
  finish(): void;
};

/** Minimal Express request/response doubles — no HTTP server needed. */
function makeRequest(headers: Record<string, unknown> = {}): TestRequest {
  return {
    method: 'GET',
    url: '/v1/wallets',
    headers: { ...headers },
  } as unknown as TestRequest;
}

function makeResponse(): TestResponse {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  return {
    headers,
    finish: () => emitter.emit('finish'),
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    on: (event: string, listener: () => void) => {
      emitter.on(event, listener);
      return undefined as never;
    },
  } as unknown as TestResponse;
}

describe('RequestLoggingMiddleware (#927)', () => {
  it('reuses a well-formed inbound id and echoes it on the response', () => {
    const req = makeRequest({ [REQUEST_ID_HEADER]: 'req-abc-123' });
    const res = makeResponse();

    new RequestLoggingMiddleware().use(req, res, jest.fn());

    expect(req.requestId).toBe('req-abc-123');
    expect(res.headers[REQUEST_ID_HEADER]).toBe('req-abc-123');
  });

  it('generates an id when the client supplied none', () => {
    const req = makeRequest();
    const res = makeResponse();

    new RequestLoggingMiddleware().use(req, res, jest.fn());

    expect(req.requestId).toMatch(UUID_RE);
    expect(res.headers[REQUEST_ID_HEADER]).toBe(req.requestId);
  });

  it('replaces a log-injection attempt instead of forwarding it', () => {
    const req = makeRequest({ [REQUEST_ID_HEADER]: 'abc\nINFO forged' });
    const res = makeResponse();

    new RequestLoggingMiddleware().use(req, res, jest.fn());

    expect(req.requestId).not.toContain('\n');
    expect(req.requestId).toMatch(UUID_RE);
    // The inbound header is re-stamped too, so no downstream layer can read
    // the attacker's original value.
    expect(req.headers[REQUEST_ID_HEADER]).toBe(req.requestId);
  });

  it('calls next and logs completion with the same correlation id', () => {
    const req = makeRequest({ [REQUEST_ID_HEADER]: 'req-abc-123' });
    const res = makeResponse();
    const debug = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    const next = jest.fn();

    try {
      new RequestLoggingMiddleware().use(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      res.finish();
      const logged = debug.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('req-abc-123');
    } finally {
      debug.mockRestore();
    }
  });
});
