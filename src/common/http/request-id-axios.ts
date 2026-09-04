import axios, { AxiosInstance, CreateAxiosDefaults } from 'axios';
import { RequestContextService } from '../request-context/request-context.service';

/**
 * Creates a pre-configured Axios instance that automatically propagates the
 * `x-request-id` header on every outbound HTTP request.
 *
 * The request ID is read from the current AsyncLocalStorage context
 * (populated by the request-logging middleware).  When no request ID is
 * active the header is omitted so downstream services behave normally.
 *
 * Usage:
 * ```typescript
 * import { createRequestIdAwareAxios } from '../common/http/request-id-axios';
 *
 * const http = createRequestIdAwareAxios({ baseURL: 'https://horizon.example.com' });
 * const res = await http.get('/transactions/abc');
 * // ^ automatically includes `x-request-id: <current-id>` in the request headers
 * ```
 *
 * @param config  Optional Axios configuration (baseURL, timeout, headers, …)
 * @returns       A configured Axios instance
 */
export function createRequestIdAwareAxios(
  config?: CreateAxiosDefaults,
): AxiosInstance {
  const instance = axios.create(config);

  instance.interceptors.request.use(
    (reqConfig) => {
      const requestId = RequestContextService.getCurrentRequestId();
      if (requestId && reqConfig.headers) {
        // Axios 1.x uses AxiosHeaders — set header via direct property assignment
        (reqConfig.headers as Record<string, unknown>)['x-request-id'] = requestId;
      } else if (requestId) {
        // Fallback for when headers object is absent
        (reqConfig as any).headers = { 'x-request-id': requestId };
      }
      return reqConfig;
    },
    (error) => Promise.reject(error),
  );

  return instance;
}
