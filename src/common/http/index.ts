export { createRequestIdAwareAxios } from './request-id-axios';
export { requestIdAwareFetch } from './request-id-fetch';
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
export { CorsModule } from './cors.module';
export { CorsAllowlistController } from './cors-dashboard.controller';
export type { CorsAllowlistReport } from './cors-dashboard.controller';
