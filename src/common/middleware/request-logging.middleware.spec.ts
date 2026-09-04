import requestLogger, {
  extractClientVersion,
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
