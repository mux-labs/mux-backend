import requestLogger from './request-logging.middleware';
import { Logger } from '@nestjs/common';
import { RequestContext } from '../context/request-context';

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

  it('propagates incoming x-request-id to response and request headers', () => {
    const incomingId = 'incoming-request-id-abc';
    const req: any = {
      method: 'GET',
      originalUrl: '/webhooks/endpoints/1',
      headers: { 'x-request-id': incomingId },
      ip: '1.2.3.4',
    };
    const res: any = {
      setHeader: jest.fn(),
      on: jest.fn(),
      statusCode: 200,
    };
    const next = jest.fn();

    requestLogger(req, res, next as any);

    expect(req.headers['x-request-id']).toBe(incomingId);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', incomingId);
    expect(next).toHaveBeenCalled();
  });

  it('generates a UUID when x-request-id is absent', () => {
    const req: any = {
      method: 'POST',
      originalUrl: '/webhooks/endpoints',
      headers: {},
      ip: '1.2.3.4',
    };
    const res: any = {
      setHeader: jest.fn(),
      on: jest.fn(),
      statusCode: 201,
    };
    const next = jest.fn();

    requestLogger(req, res, next as any);

    expect(req.headers['x-request-id']).toEqual(expect.any(String));
    expect(req.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      req.headers['x-request-id'],
    );
  });

  it('runs downstream handlers within RequestContext', () => {
    const req: any = {
      method: 'GET',
      originalUrl: '/test',
      headers: { 'x-request-id': 'ctx-test-id' },
      ip: '1.2.3.4',
    };
    const res: any = {
      setHeader: jest.fn(),
      on: jest.fn(),
      statusCode: 200,
    };
    let capturedId: string | undefined;
    const next = jest.fn(() => {
      capturedId = RequestContext.getRequestId();
    });

    requestLogger(req, res, next as any);

    expect(capturedId).toBe('ctx-test-id');
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
});
