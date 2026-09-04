/**
 * Request-id-aware fetch — unit tests
 *
 * Covers:
 *  - Adds x-request-id header when a request ID is active in context
 *  - Omits x-request-id header when no request ID is active
 *  - Preserves existing custom headers
 */
import { requestIdAwareFetch } from './request-id-fetch';
import { RequestContextService } from '../request-context/request-context.service';

// Mock the global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('requestIdAwareFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
  });

  it('adds x-request-id header when a request ID is active in context', async () => {
    await RequestContextService.run({ requestId: 'fetch-req-001' }, async () => {
      await requestIdAwareFetch('https://example.com/api');
    });

    const callHeaders = mockFetch.mock.calls[0][1]?.headers;
    expect(callHeaders).toBeDefined();
    expect(callHeaders.get('x-request-id')).toBe('fetch-req-001');
  });

  it('omits x-request-id header when no request ID is active', async () => {
    await requestIdAwareFetch('https://example.com/api');

    const callHeaders = mockFetch.mock.calls[0][1]?.headers;
    expect(callHeaders).toBeDefined();
    expect(callHeaders.has('x-request-id')).toBe(false);
  });

  it('preserves existing custom headers on the outgoing request', async () => {
    await RequestContextService.run({ requestId: 'req-ctx' }, async () => {
      await requestIdAwareFetch('https://example.com/api', {
        headers: { 'x-custom': 'my-value' },
      });
    });

    const callHeaders = mockFetch.mock.calls[0][1]?.headers;
    expect(callHeaders.get('x-request-id')).toBe('req-ctx');
    expect(callHeaders.get('x-custom')).toBe('my-value');
  });
});
