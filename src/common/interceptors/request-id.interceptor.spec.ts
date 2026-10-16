import { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  MAX_REQUEST_ID_LENGTH,
  PUBLIC_ENDPOINT_ALLOWLIST,
  REQUEST_ID_HEADER,
  RequestIdInterceptor,
  isPublicEndpoint,
  normalizeRequestPath,
  resolveRequestId,
} from './request-id.interceptor';

interface MockRequest {
  headers: Record<string, string | undefined>;
  path?: string;
  url?: string;
  requestId?: string;
}

interface MockResponse {
  setHeader: jest.Mock;
}

function createContext(
  request: MockRequest,
  response: MockResponse,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('RequestIdInterceptor', () => {
  let interceptor: RequestIdInterceptor;
  let response: MockResponse;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [RequestIdInterceptor],
    }).compile();

    interceptor = moduleRef.get(RequestIdInterceptor);
    response = { setHeader: jest.fn() };
  });

  it('echoes a client-supplied X-Request-ID header', () => {
    const request: MockRequest = {
      headers: { [REQUEST_ID_HEADER.toLowerCase()]: 'client-supplied-id' },
    };

    const result = interceptor.intercept(
      createContext(request, response),
      { handle: () => ({}) } as never,
    );

    expect(result).toBeDefined();
    expect(request.requestId).toBe('client-supplied-id');
    expect(response.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      'client-supplied-id',
    );
  });

  it('generates a request id when the header is absent', () => {
    const request: MockRequest = { headers: {} };

    interceptor.intercept(createContext(request, response), {
      handle: () => ({}),
    } as never);

    expect(request.requestId).toBeDefined();
    expect(typeof request.requestId).toBe('string');
    expect(request.requestId).not.toHaveLength(0);
    expect(response.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      request.requestId,
    );
  });

  it('enforces MAX_REQUEST_ID_LENGTH on over-long ids', () => {
    const overLong = 'a'.repeat(MAX_REQUEST_ID_LENGTH + 50);
    const request: MockRequest = {
      headers: { [REQUEST_ID_HEADER.toLowerCase()]: overLong },
    };

    interceptor.intercept(createContext(request, response), {
      handle: () => ({}),
    } as never);

    expect(request.requestId).toBeDefined();
    expect((request.requestId as string).length).toBeLessThanOrEqual(
      MAX_REQUEST_ID_LENGTH,
    );
  });
});

describe('resolveRequestId', () => {
  it('returns the supplied id when within the length cap', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
  });

  it('caps ids that exceed MAX_REQUEST_ID_LENGTH', () => {
    const overLong = 'x'.repeat(MAX_REQUEST_ID_LENGTH + 10);
    const resolved = resolveRequestId(overLong);

    expect(resolved.length).toBeLessThanOrEqual(MAX_REQUEST_ID_LENGTH);
  });

  it('generates an id when none is supplied', () => {
    const resolved = resolveRequestId(undefined);

    expect(typeof resolved).toBe('string');
    expect(resolved).not.toHaveLength(0);
  });
});

describe('normalizeRequestPath', () => {
  it('strips query strings', () => {
    expect(normalizeRequestPath('/health?verbose=true')).toBe('/health');
  });

  it('strips trailing slashes', () => {
    expect(normalizeRequestPath('/health/')).toBe('/health');
  });

  it('strips both query strings and trailing slashes', () => {
    expect(normalizeRequestPath('/health/?verbose=true')).toBe('/health');
  });

  it('leaves a clean path unchanged', () => {
    expect(normalizeRequestPath('/health')).toBe('/health');
  });
});

describe('isPublicEndpoint', () => {
  it('matches allowlisted routes', () => {
    for (const route of PUBLIC_ENDPOINT_ALLOWLIST) {
      expect(isPublicEndpoint(route)).toBe(true);
    }
  });

  it('matches allowlisted routes regardless of query string or trailing slash', () => {
    const route = PUBLIC_ENDPOINT_ALLOWLIST[0];
    expect(isPublicEndpoint(`${route}/?probe=1`)).toBe(true);
  });

  it('does not match non-allowlisted routes', () => {
    expect(isPublicEndpoint('/definitely-not-public')).toBe(false);
  });
});
