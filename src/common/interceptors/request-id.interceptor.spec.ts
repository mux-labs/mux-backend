import { RequestIdInterceptor } from './request-id.interceptor';
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { RequestContextService } from '../request-context/request-context.service';

describe('RequestIdInterceptor', () => {
  let interceptor: RequestIdInterceptor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RequestIdInterceptor],
    }).compile();
    interceptor = module.get(RequestIdInterceptor);
  });

  function createMockContext(
    headers: Record<string, string | string[] | undefined> = {},
  ): ExecutionContext {
    const responseHeaders: Record<string, string> = {};
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
        }),
        getResponse: () => ({
          setHeader: (key: string, value: string) => {
            responseHeaders[key] = value;
          },
          getHeader: (key: string) => responseHeaders[key],
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('should use the incoming x-request-id header when provided', (done) => {
    const incomingId = 'client-provided-id-123';
    const context = createMockContext({ 'x-request-id': incomingId });

    const callHandler: CallHandler = {
      handle: () => {
        // Verify requestId is set in the AsyncLocalStorage context
        const storedId = RequestContextService.getCurrentRequestId();
        expect(storedId).toBe(incomingId);
        return of({ success: true });
      },
    };

    interceptor.intercept(context, callHandler).subscribe({
      next: (body: any) => {
        // Verify the response has the header set
        const response = context.switchToHttp().getResponse();
        expect(response.getHeader('x-request-id')).toBe(incomingId);
        expect(body).toEqual({ success: true });
        done();
      },
    });
  });

  it('should generate a UUID request ID when the header is absent', (done) => {
    const context = createMockContext({});

    const callHandler: CallHandler = {
      handle: () => {
        const storedId = RequestContextService.getCurrentRequestId();
        expect(storedId).toBeDefined();
        expect(typeof storedId).toBe('string');
        expect(storedId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        return of({ success: true });
      },
    };

    interceptor.intercept(context, callHandler).subscribe({
      next: () => {
        const response = context.switchToHttp().getResponse();
        expect(response.getHeader('x-request-id')).toBeDefined();
        done();
      },
    });
  });

  it('should still set the request ID on the response when the handler throws', (done) => {
    const context = createMockContext({ 'x-request-id': 'error-test-id' });

    const callHandler: CallHandler = {
      handle: () => throwError(() => new Error('handler error')),
    };

    interceptor.intercept(context, callHandler).subscribe({
      error: () => {
        const response = context.switchToHttp().getResponse();
        expect(response.getHeader('x-request-id')).toBe('error-test-id');
        done();
      },
    });
  });

  it('should propagate to RequestContextService and be retrievable', (done) => {
    const incomingId = 'propagation-test-id';
    const context = createMockContext({ 'x-request-id': incomingId });

    const callHandler: CallHandler = {
      handle: () => {
        const idFromService = RequestContextService.getCurrentRequestId();
        expect(idFromService).toBe(incomingId);
        return of({ data: 'ok' });
      },
    };

    interceptor.intercept(context, callHandler).subscribe({
      next: () => {
        // After the handler processes, the context should still be accessible
        // within the same async flow
        const idAfter = RequestContextService.getCurrentRequestId();
        expect(idAfter).toBe(incomingId);
        done();
      },
    });
  });
});
