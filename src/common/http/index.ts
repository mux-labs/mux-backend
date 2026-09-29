/**
 * Barrel for the shared HTTP-layer policy modules.
 *
 * Exported so `main.ts` can wire the transport-level concerns (#933 probes,
 * #934 CORS allowlist, #935 security headers) from a single import.
 */
export {
  SECURITY_HEADERS,
  isHstsEnabled,
  securityHeaders,
} from './security-headers';
export {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE_SECONDS,
  CORS_METHODS,
  buildCorsOptions,
  isOriginAllowed,
  normalizeOrigin,
  parseCorsAllowlist,
} from './cors';
export { MAX_BODY_SIZE, configureBodySizeLimit } from './body-size-limit';
