import requestLogger, {
  extractClientVersion,
  redactSensitiveHeaders,
  isSensitiveHeader,
} from './request-logging.middleware';
import { Logger } from '@nestjs/common';
import { RequestContextService } from '../request-context/request-context.service';

describe('requestLogger', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('sets x-request-id, logs and calls next', () => {
    const req: any = {
      method: 'GET',
      originalUrl: '/test',
      headers: {},
      ip: '1.2.3.4',
    };
    const finishCallbacks: Record<string, Function[]> = { finish: [] };
    const res: any = {
      setHeader: jest.fn(),
      on: (event: string, cb: Function) => {
        finishCallbacks[event].push(cb);
      },
      statusCode: 200,
    };
    const next = jest.fn();

    const spyLog = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});

    requestLogger(req, res, next as any);

    expect(res.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      expect.any(String),
    );
    expect(next).toHaveBeenCalled();
    expect(spyLog).toHaveBeenCalled();

    // simulate finish handlers
    finishCallbacks.finish.forEach((cb) => cb());
    expect(spyLog).toHaveBeenCalled();
  });

  it('preserves an incoming x-request-id header', () => {
    const req: any = {
      method: 'POST',
      originalUrl: '/test',
      headers: { 'x-request-id': 'req-123' },
      ip: '1.2.3.4',
    };
    const res: any = {
      setHeader: jest.fn(),
      on: jest.fn(),
      statusCode: 200,
    };
    const next = jest.fn();

    requestLogger(req, res, next as any);

    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req-123');
    expect(next).toHaveBeenCalled();
  });

  it('handles invalid/stale request objects gracefully', () => {
    const req: any = null;
    const res: any = { setHeader: jest.fn(), on: jest.fn() };
    const next = jest.fn();

    const spyWarn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});

    requestLogger(req, res, next as any);

    expect(next).toHaveBeenCalled();
    expect(spyWarn).toHaveBeenCalled();
  });

  it('attaches request ID to request object', () => {
    const req: any = {
      method: 'GET',
      originalUrl: '/test',
      headers: {},
      ip: '1.2.3.4',
    };
    const finishCallbacks: Record<string, Function[]> = { finish: [] };
    const res: any = {
      setHeader: jest.fn(),
      on: (event: string, cb: Function) => {
        finishCallbacks[event].push(cb);
      },
      statusCode: 200,
    };
    const next = jest.fn();

    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});

    requestLogger(req, res, next as any);

    expect(req.requestId).toBeDefined();
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId.length).toBeGreaterThan(0);
  });

  it('forwards existing x-request-id header to request object', () => {
    const existingId = 'existing-request-id-123';
    const req: any = {
      method: 'GET',
      originalUrl: '/test',
      headers: { 'x-request-id': existingId },
      ip: '1.2.3.4',
    };
    const finishCallbacks: Record<string, Function[]> = { finish: [] };
    const res: any = {
      setHeader: jest.fn(),
      on: (event: string, cb: Function) => {
        finishCallbacks[event].push(cb);
      },
      statusCode: 200,
    };
    const next = jest.fn();

    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});

    requestLogger(req, res, next as any);

    expect(req.requestId).toBe(existingId);
  });

  it('propagates request ID into RequestContextService async context', () => {
    const req: any = {
      method: 'GET',
      originalUrl: '/test',
      headers: {},
      ip: '1.2.3.4',
    };
    const res: any = {
      setHeader: jest.fn(),
      on: jest.fn(),
      statusCode: 200,
    };

    let capturedRequestId: string | undefined;
    const next = jest.fn().mockImplementation(() => {
      const service = new RequestContextService();
      capturedRequestId = service.getRequestId();
    });

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    requestLogger(req, res, next as any);

    expect(next).toHaveBeenCalled();
    expect(capturedRequestId).toBeDefined();
    expect(capturedRequestId).toBe(req.requestId);
  });

  describe('X-Client-Version header', () => {
    it('extractClientVersion returns a trimmed value when the header is present and well-formed', () => {
      const req: any = { headers: { 'x-client-version': '  2.4.1  ' } };
      expect(extractClientVersion(req)).toBe('2.4.1');
    });

    it('extractClientVersion returns undefined when the header is absent', () => {
      const req: any = { headers: {} };
      expect(extractClientVersion(req)).toBeUndefined();
    });

    it('extractClientVersion returns undefined for an empty header value', () => {
      const req: any = { headers: { 'x-client-version': '   ' } };
      expect(extractClientVersion(req)).toBeUndefined();
    });

    it('extractClientVersion returns undefined for a malformed/unsafe header value', () => {
      const req: any = {
        headers: { 'x-client-version': 'bad value\nwith-newline' },
      };
      expect(extractClientVersion(req)).toBeUndefined();
    });

    it('extractClientVersion returns undefined for an over-long header value', () => {
      const req: any = { headers: { 'x-client-version': 'v'.repeat(200) } };
      expect(extractClientVersion(req)).toBeUndefined();
    });

    it('extractClientVersion handles a request with no headers object gracefully', () => {
      const req: any = null;
      expect(extractClientVersion(req)).toBeUndefined();
    });

    it('captures a present client version on the request and in the log context', () => {
      const req: any = {
        method: 'GET',
        originalUrl: '/test',
        headers: { 'x-client-version': '3.1.0' },
        ip: '1.2.3.4',
      };
      const res: any = { setHeader: jest.fn(), on: jest.fn(), statusCode: 200 };

      let capturedClientVersion: string | undefined;
      const next = jest.fn().mockImplementation(() => {
        const service = new RequestContextService();
        capturedClientVersion = service.getClientVersion();
      });

      const spyLog = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});

      requestLogger(req, res, next as any);

      expect(req.clientVersion).toBe('3.1.0');
      expect(next).toHaveBeenCalled();
      expect(capturedClientVersion).toBe('3.1.0');
      expect(spyLog).toHaveBeenCalledWith(
        expect.stringContaining('clientVersion=3.1.0'),
      );
    });

    it('omits the client version and still processes the request when the header is missing', () => {
      const req: any = {
        method: 'GET',
        originalUrl: '/test',
        headers: {},
        ip: '1.2.3.4',
      };
      const res: any = { setHeader: jest.fn(), on: jest.fn(), statusCode: 200 };

      let capturedClientVersion: string | undefined = 'unset';
      const next = jest.fn().mockImplementation(() => {
        const service = new RequestContextService();
        capturedClientVersion = service.getClientVersion();
      });

      const spyLog = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});

      requestLogger(req, res, next as any);

      expect(req.clientVersion).toBeUndefined();
      expect(next).toHaveBeenCalled();
      expect(capturedClientVersion).toBeUndefined();
      expect(spyLog).toHaveBeenCalledWith(
        expect.not.stringContaining('clientVersion='),
      );
    });

    it('does not break the request when the header value is malformed', () => {
      const req: any = {
        method: 'GET',
        originalUrl: '/test',
        headers: { 'x-client-version': 'not\na valid version!!' },
        ip: '1.2.3.4',
      };
      const res: any = { setHeader: jest.fn(), on: jest.fn(), statusCode: 200 };
      const next = jest.fn();

      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      expect(() => requestLogger(req, res, next as any)).not.toThrow();
      expect(next).toHaveBeenCalled();
      expect(req.clientVersion).toBeUndefined();
    });
  });
});

// ─── #787 Header redaction ────────────────────────────────────────────────────

describe('#787 isSensitiveHeader()', () => {
  it('identifies Authorization as sensitive (any case)', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('authorization')).toBe(true);
    expect(isSensitiveHeader('AUTHORIZATION')).toBe(true);
  });

  it('identifies X-API-Key as sensitive (any case)', () => {
    expect(isSensitiveHeader('X-API-Key')).toBe(true);
    expect(isSensitiveHeader('x-api-key')).toBe(true);
  });

  it('identifies X-Internal-Api-Key as sensitive', () => {
    expect(isSensitiveHeader('x-internal-api-key')).toBe(true);
  });

  it('identifies X-Maintenance-Secret as sensitive', () => {
    expect(isSensitiveHeader('x-maintenance-secret')).toBe(true);
  });

  it('identifies X-Recovery-Admin-Secret as sensitive', () => {
    expect(isSensitiveHeader('x-recovery-admin-secret')).toBe(true);
  });

  it('identifies cookie / set-cookie as sensitive', () => {
    expect(isSensitiveHeader('cookie')).toBe(true);
    expect(isSensitiveHeader('set-cookie')).toBe(true);
  });

  it('identifies proxy-authorization as sensitive', () => {
    expect(isSensitiveHeader('proxy-authorization')).toBe(true);
  });

  it('does NOT mark safe headers as sensitive', () => {
    expect(isSensitiveHeader('content-type')).toBe(false);
    expect(isSensitiveHeader('accept')).toBe(false);
    expect(isSensitiveHeader('x-request-id')).toBe(false);
    expect(isSensitiveHeader('x-client-version')).toBe(false);
    expect(isSensitiveHeader('user-agent')).toBe(false);
  });
});

describe('#787 redactSensitiveHeaders()', () => {
  it('replaces Authorization with [REDACTED]', () => {
    const result = redactSensitiveHeaders({ authorization: 'Bearer secret-token' });
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('replaces X-API-Key with [REDACTED]', () => {
    const result = redactSensitiveHeaders({ 'x-api-key': 'mux_live_abc123' });
    expect(result['x-api-key']).toBe('[REDACTED]');
  });

  it('replaces cookie with [REDACTED]', () => {
    const result = redactSensitiveHeaders({ cookie: 'session=top-secret' });
    expect(result.cookie).toBe('[REDACTED]');
  });

  it('preserves non-sensitive header values unchanged', () => {
    const result = redactSensitiveHeaders({
      'content-type': 'application/json',
      'x-request-id': 'req-abc',
      authorization: 'Bearer token',
    });
    expect(result['content-type']).toBe('application/json');
    expect(result['x-request-id']).toBe('req-abc');
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('handles mixed-case header names correctly', () => {
    const result = redactSensitiveHeaders({
      Authorization: 'Bearer mixed-case-token',
      'Content-Type': 'application/json',
    });
    expect(result['Authorization']).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('application/json');
  });

  it('returns an empty object when headers is undefined', () => {
    expect(redactSensitiveHeaders(undefined)).toEqual({});
  });

  it('returns an empty object when headers is null-ish', () => {
    expect(redactSensitiveHeaders(null as any)).toEqual({});
  });

  it('does not mutate the original headers object', () => {
    const original = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    redactSensitiveHeaders(original);
    // Original must be untouched
    expect(original.authorization).toBe('Bearer secret');
  });

  it('handles array header values for sensitive headers', () => {
    const result = redactSensitiveHeaders({
      'set-cookie': ['sessionId=abc', 'token=xyz'],
    });
    expect(result['set-cookie']).toBe('[REDACTED]');
  });
});

describe('#787 requestLogger — sensitive headers are never logged', () => {
  it('does not include Authorization header value in any log line', () => {
    const req: any = {
      method: 'POST',
      originalUrl: '/v1/wallets',
      headers: {
        authorization: 'Bearer super-secret-jwt-token',
        'content-type': 'application/json',
      },
      ip: '10.0.0.1',
    };
    const res: any = { setHeader: jest.fn(), on: jest.fn(), statusCode: 200 };
    const next = jest.fn();

    const loggedLines: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: any) => {
      loggedLines.push(typeof msg === 'string' ? msg : String(msg));
    });

    requestLogger(req, res, next);

    expect(next).toHaveBeenCalled();
    // The literal token value must never appear in any logged line
    for (const line of loggedLines) {
      expect(line).not.toContain('super-secret-jwt-token');
      expect(line).not.toContain('Bearer super-secret-jwt-token');
    }
  });

  it('does not include X-API-Key header value in any log line', () => {
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/wallets',
      headers: {
        'x-api-key': 'mux_live_VERY_SECRET_KEY_12345',
      },
      ip: '10.0.0.2',
    };
    const res: any = { setHeader: jest.fn(), on: jest.fn(), statusCode: 200 };
    const next = jest.fn();

    const loggedLines: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: any) => {
      loggedLines.push(typeof msg === 'string' ? msg : String(msg));
    });

    requestLogger(req, res, next);

    for (const line of loggedLines) {
      expect(line).not.toContain('mux_live_VERY_SECRET_KEY_12345');
    }
  });

  it('does not include cookie value in any log line', () => {
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/health',
      headers: {
        cookie: 'session=abc123secret; token=def456secret',
      },
      ip: '10.0.0.3',
    };
    const res: any = { setHeader: jest.fn(), on: jest.fn(), statusCode: 200 };
    const next = jest.fn();

    const loggedLines: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: any) => {
      loggedLines.push(typeof msg === 'string' ? msg : String(msg));
    });

    requestLogger(req, res, next);

    for (const line of loggedLines) {
      expect(line).not.toContain('abc123secret');
      expect(line).not.toContain('def456secret');
    }
  });

  it('still logs safe header-derived context (method, url, ip, request-id)', () => {
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/health',
      headers: {
        'x-request-id': 'safe-req-id',
        authorization: 'Bearer secret',
      },
      ip: '1.2.3.4',
    };
    const res: any = { setHeader: jest.fn(), on: jest.fn(), statusCode: 200 };
    const next = jest.fn();

    const loggedLines: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: any) => {
      loggedLines.push(typeof msg === 'string' ? msg : String(msg));
    });

    requestLogger(req, res, next);

    const startLine = loggedLines.find((l) => l.includes('/v1/health'));
    expect(startLine).toBeDefined();
    expect(startLine).toContain('GET');
    expect(startLine).toContain('ip=1.2.3.4');
    expect(startLine).toContain('id=safe-req-id');
    // The Authorization value must be absent
    expect(startLine).not.toContain('Bearer secret');
  });
});
