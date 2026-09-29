// The correlation surface (#927) is re-exported here so a consumer can reach
// `REQUEST_ID_HEADER` / `resolveRequestId` through the `interceptors` barrel.
// Previously only the interceptor classes were exported, so importing
// `resolveRequestId` from this path silently yielded `undefined` at runtime —
// a trap the correlation module had to work around by importing the file
// directly. Keeping the barrel complete means there is one import path.
export {
  IsoUtcTimestampInterceptor,
  RequestIdInterceptor,
  REQUEST_ID_HEADER,
  MAX_REQUEST_ID_LENGTH,
  resolveRequestId,
} from './request-id.interceptor';
