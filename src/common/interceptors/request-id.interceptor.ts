import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';

/**
 * Header used to propagate a correlation id across services and logs.
 * Clients may supply their own value; otherwise the server generates one.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Maximum accepted length for a client-supplied correlation id. Longer values
 * are rejected and replaced with a server-generated id to avoid log injection
 * and unbounded header amplification on privileged surfaces (e.g. tx export).
 */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Correlation ids must be opaque and safe to embed in logs, metrics labels,
 * and error payloads. We only accept a conservative character set so that
 * adversarial input cannot spoof structured log fields or inject control chars.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Only allow opaque, log-safe identifiers. Rejecting control characters and
 * whitespace prevents header/log injection through a spoofed request id.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

/**
 * Resolves a trustworthy request id: reuse a well-formed inbound value when
 * present, otherwise generate a new one. Never trust arbitrary client input.
 */
export function resolveRequestId(inbound?: unknown): string {
  if (
    typeof inbound === 'string' &&
    inbound.length > 0 &&
    inbound.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID.test(inbound)
  ) {
    return inbound;
  }
  return randomUUID();
}

/**
 * Explicit allowlist of public (unauthenticated) endpoints. Every route that is
 * not matched here is treated as privileged and must be authenticated by the
 * global auth guard. This is the single source of truth for the public surface
 * so that adding a route never silently exposes it without auth.
 *
 * Entries are matched against the request path (query string stripped) using
 * exact matches or a trailing `*` wildcard. Keep this list minimal and review
 * every addition: deny-by-default is the invariant.
 */
export const PUBLIC_ENDPOINT_ALLOWLIST: readonly string[] = [
  '/health',
  '/health/*',
  '/metrics',
  '/auth/challenge',
  '/auth/verify',
  '/auth/refresh',
];

/**
 * Stable error code returned when a non-allowlisted route is reached without
 * authentication. Kept constant so clients and dashboards can rely on it.
 */
export const UNAUTHENTICATED_ERROR_CODE = 'AUTH_UNAUTHENTICATED';

/**
 * Normalizes a request path for allowlist matching: strips the query string and
 * any trailing slash so `/health/` and `/health?x=1` both match `/health`.
 */
export function normalizeRequestPath(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '';
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

/**
 * Deny-by-default check: returns true only when the path is explicitly listed
 * as public. Supports exact matches and a single trailing `*` wildcard.
 */
export function isPublicEndpoint(path: string): boolean {
  const normalized = normalizeRequestPath(path);

  for (const entry of PUBLIC_ENDPOINT_ALLOWLIST) {
    if (entry.endsWith('*')) {
      const prefix = entry.slice(0, -1);
      if (normalized.startsWith(prefix)) {
        return true;
      }
    } else if (normalized === entry) {
      return true;
    }
  }

  return false;
}

/**
 * Assigns a correlation id to every request, echoes it back on the response
 * and exposes it on the request so the error envelope and logs can include it.
 *
 * The interceptor also enforces the public endpoint allowlist: any request to a
 * non-allowlisted route that has not been authenticated is rejected fail-closed
 * with a stable error code and the correlation id, so clients cannot bypass
 * policy by hitting privileged routes directly. Authentication is signalled by
 * the auth guard attaching `request.user` (or an API-key principal); the
 * interceptor never inspects or logs raw credentials.
 *
 * Internal cron-triggered endpoints are guarded by a required cron secret
 * (see CronSecretGuard). Auth failures on those routes are surfaced with a
 * stable error code and the correlation id below, without ever echoing the
 * secret material back to the caller.
 *
 * The id is also used by privileged entrypoints (transaction export jobs,
 * wallet/payment APIs) so they can emit stable, traceable error codes without
 * leaking secrets. The id is echoed back on the response and exposed on the
 * request for downstream handlers and loggers.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      headers?: Record<string, unknown>;
      method?: string;
      originalUrl?: string;
      url?: string;
      path?: string;
      requestId?: string;
      user?: unknown;
      apiKey?: unknown;
    }>();
    const response = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();

    const requestId = this.resolveRequestId(request?.headers);

    if (request) {
      request.requestId = requestId;
    }

    if (response && typeof response.setHeader === 'function') {
      response.setHeader(REQUEST_ID_HEADER, requestId);
    }

    this.enforcePublicAllowlist(request);

    return next.handle();
  }

  /**
   * Fail-closed authorization gate. Public routes pass through untouched; every
   * other route must carry an authenticated principal (set by the auth guard)
   * or the request is rejected with a stable, non-leaking error code.
   */
  private enforcePublicAllowlist(request?: {
    method?: string;
    originalUrl?: string;
    url?: string;
    path?: string;
    requestId?: string;
    user?: unknown;
    apiKey?: unknown;
  }): void {
    if (!request) {
      return;
    }

    const path = request.originalUrl ?? request.url ?? request.path ?? '';

    if (isPublicEndpoint(path)) {
      return;
    }

    const authenticated = Boolean(request.user) || Boolean(request.apiKey);

    if (!authenticated) {
      const error = new Error('Authentication required for this endpoint') as Error & {
        status?: number;
        code?: string;
        requestId?: string;
      };
      error.status = 401;
      error.code = UNAUTHENTICATED_ERROR_CODE;
      error.requestId = request.requestId;
      throw error;
    }
  }

  /**
   * Fail-closed resolution: only well-formed, bounded client ids are trusted;
   * anything else is replaced with a freshly generated UUID.
   */
  private resolveRequestId(headers?: Record<string, unknown>): string {
    const raw = headers?.[REQUEST_ID_HEADER] ?? headers?.[REQUEST_ID_HEADER.toUpperCase()];
    const candidate = Array.isArray(raw) ? raw[0] : raw;

    if (typeof candidate !== 'string') {
      return randomUUID();
    }

    const trimmed = candidate.trim();

    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_REQUEST_ID_LENGTH ||
      !REQUEST_ID_PATTERN.test(trimmed)
    ) {
      return randomUUID();
    }

    return trimmed;
  }
}
