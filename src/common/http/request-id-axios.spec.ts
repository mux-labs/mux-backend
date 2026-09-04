/**
 * Request-id-aware Axios — unit tests
 *
 * Covers:
 *  - Adds x-request-id header when a request ID is active in context
 *  - Omits x-request-id header when no request ID is active
 *  - Preserves existing headers on the outgoing request
 */
import { createRequestIdAwareAxios } from './request-id-axios';
import { RequestContextService } from '../request-context/request-context.service';

describe('createRequestIdAwareAxios', () => {
  /** Create a client with a custom adapter that captures the final headers. */
  async function captureHeaders(
    requestId: string | null,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, string> | undefined> {
    const client = createRequestIdAwareAxios({ baseURL: 'https://example.com' });
    let captured: Record<string, string> | undefined;

    // Override the adapter to capture the config before the real HTTP call
    (client as any).defaults.adapter = (config: any) => {
      const h: Record<string, string> = {};
      // AxiosHeaders is iterable via forEach
      if (typeof config.headers?.forEach === 'function') {
        config.headers.forEach((v: string, k: string) => { h[k] = v; });
      } else if (config.headers) {
        Object.assign(h, config.headers);
      }
      captured = h;
      return Promise.resolve({ data: null, status: 200, statusText: 'OK', headers: {}, config });
    };

    const action = async () => {
      await client.get('/test', extraHeaders ? { headers: extraHeaders } : undefined);
    };

    if (requestId) {
      await RequestContextService.run({ requestId }, action);
    } else {
      await action();
    }

    return captured;
  }

  it('adds x-request-id header when a request ID is active in context', async () => {
    const headers = await captureHeaders('ctx-req-001');
    expect(headers).toBeDefined();
    expect(headers!['x-request-id']).toBe('ctx-req-001');
  });

  it('omits x-request-id header when no request ID is active', async () => {
    const headers = await captureHeaders(null);
    expect(headers).toBeDefined();
    expect(headers!['x-request-id']).toBeUndefined();
  });

  it('preserves existing custom headers on the outgoing request', async () => {
    const headers = await captureHeaders('req-with-custom', { 'x-custom': 'my-value' });
    expect(headers).toBeDefined();
    expect(headers!['x-request-id']).toBe('req-with-custom');
    expect(headers!['x-custom']).toBe('my-value');
  });
});
