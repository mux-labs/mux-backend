import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS allowlist configuration ([#934]).
 *
 * The API is called cross-origin by the Mux dashboard, so CORS has to be
 * configured. The failure mode to avoid is a permissive default: this service
 * custodies keys and signs transactions, so an origin that should not be
 * talking to it must be refused.
 *
 * ## Invariants
 *
 * 1. **Deny-by-default.** An origin is allowed only on an exact, literal match
 *    against the configured allowlist. There is no suffix, wildcard, or
 *    subdomain matching — `evil-app.mux.finance` must not be admitted by an
 *    entry for `mux.finance`.
 * 2. **No wildcard origin, ever.** `Access-Control-Allow-Origin: *` is
 *    forbidden alongside `credentials: true` by the CORS spec, and honouring
 *    it would hand every origin access to authenticated responses. Wildcard
 *    entries in configuration are dropped and reported.
 * 3. **Same-origin and non-browser callers are unaffected.** A request with no
 *    `Origin` header is not a browser cross-origin request, so it is allowed;
 *    CORS is a browser-enforced mechanism and adding an auth layer on top of
 *    it would only break curl and server-to-server clients.
 * 4. **`Vary: Origin` is always set.** Without it, a shared cache can serve one
 *    origin's response (with its `Access-Control-Allow-Origin`) to another
 *    origin. The `cors` package sets this only for non-allowlisted origins, so
 *    we set it unconditionally.
 *
 * Credentials stay enabled (`credentials: true`) because the dashboard uses
 * cookie/session-bearing requests. That combination is safe only because
 * `Access-Control-Allow-Origin` is always a specific allowlisted origin and
 * never `*`.
 */

/** Methods the API exposes. Kept explicit so the preflight is minimal. */
export const CORS_METHODS: readonly string[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

/** Request headers a browser client may send. */
export const CORS_ALLOWED_HEADERS: readonly string[] = [
  'Content-Type',
  'Authorization',
  'X-API-Key',
  'X-Request-ID',
  'X-Client-Version',
];

/** Response headers a browser client is allowed to read. */
export const CORS_EXPOSED_HEADERS: readonly string[] = [
  'X-Request-ID',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

/** How long a browser may cache the preflight result, in seconds. */
export const CORS_MAX_AGE_SECONDS = 3600;

/**
 * Normalizes an origin for comparison: lower-cased and stripped of a trailing
 * slash, so `https://app.mux.finance/` and `https://app.mux.finance` are the
 * same allowlist entry. The browser sends the origin without a trailing slash,
 * so comparing un-normalized values would silently fail to match.
 */
export function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * An origin is allowed only on an exact match against the allowlist.
 *
 * Deliberately not implemented with `endsWith`/`includes`/regex: any of those
 * would admit `https://evil.com/?x=https://app.mux.finance` or
 * `https://app.mux.finance.evil.com`.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: readonly string[],
): boolean {
  // A request without an Origin header is not a browser cross-origin request
  // (curl, server-to-server, same-origin navigations). See invariant 3.
  if (!origin) {
    return true;
  }

  const candidate = normalizeOrigin(origin);
  return allowlist.some((entry) => normalizeOrigin(entry) === candidate);
}

/**
 * Splits the configured allowlist into usable entries and rejected ones.
 *
 * A wildcard entry (`*`) is rejected rather than honoured: it is invalid
 * alongside `credentials: true` and would allow every origin. Entries with a
 * wildcard anywhere (`https://*.mux.finance`) are rejected for the same
 * reason — the matching cannot be done safely.
 */
export function parseCorsAllowlist(raw: readonly string[]): {
  allowed: string[];
  rejected: Array<{ entry: string; reason: string }>;
} {
  const allowed: string[] = [];
  const rejected: Array<{ entry: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.includes('*')) {
      rejected.push({
        entry: trimmed,
        reason: 'wildcard origins are not allowed with credentials enabled',
      });
      continue;
    }

    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    allowed.push(trimmed);
  }

  return { allowed, rejected };
}

/**
 * Builds the CORS options from a configured allowlist.
 *
 * Used by `main.ts` and reported by the allowlist dashboard so that the
 * effective policy is inspectable without reading env vars.
 */
export function buildCorsOptions(rawAllowlist: readonly string[]): CorsOptions {
  const { allowed } = parseCorsAllowlist(rawAllowlist);
  const allowlist = allowed.map(normalizeOrigin);

  return {
    // Exact-match only. A disallowed origin is refused with an error, which
    // Nest/cors turns into a 500 with no CORS headers — the browser then blocks
    // the response. We never echo a partial or wildcard origin back.
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ): void => {
      if (isOriginAllowed(origin, allowlist)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS policy'), false);
    },
    credentials: true,
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: CORS_MAX_AGE_SECONDS,
    optionsSuccessStatus: 204,
  };
}
