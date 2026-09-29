import { RequestContextService } from '../request-context/request-context.service';

/**
 * Wraps the built-in `fetch` so that every outbound request automatically
 * includes the current `x-request-id` header (when one is active in
 * AsyncLocalStorage).
 *
 * Usage — replace global fetch:
 * ```typescript
 * import { requestIdAwareFetch } from '../common/http/request-id-fetch';
 *
 * const response = await requestIdAwareFetch('https://friendbot.example.com', {
 *   method: 'GET',
 * });
 * ```
 *
 * @param input   URL or Request object
 * @param init    Optional init overrides (headers, method, etc.)
 * @returns       Same as the native `fetch` — a Promise<Response>
 */
export async function requestIdAwareFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const requestId = RequestContextService.getCurrentRequestId();
  const headers = new Headers(init?.headers);

  if (requestId && !headers.has('x-request-id')) {
    headers.set('x-request-id', requestId);
  }

  return fetch(input, { ...init, headers });
}
