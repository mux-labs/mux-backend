import { ErrorCode } from './error-envelope.dto';

/**
 * Typed, frontend-facing catalog of every {@link ErrorCode} (#949).
 *
 * The API already returns a stable `errorCode` in every error envelope, but
 * clients had no single place to learn what a code *means* or what to do about
 * it. This catalog is that contract:
 *
 * - **Exhaustive by construction.** Entries are declared as a
 *   `Record<ErrorCode, …>`, so adding a code to the enum without documenting it
 *   here is a compile error (and a failing unit test).
 * - **Stable.** Codes are append-only: never rename or repurpose one, because
 *   frontends branch on them.
 * - **Secret-free.** Entries contain no key material, tokens, or upstream
 *   detail — only the code, status, a client-safe message, and guidance.
 * - **Machine-readable.** Served verbatim at `GET /v1/error-codes` so an SDK
 *   can generate constants instead of hard-coding strings.
 *
 * See docs/ERROR-CODES.md for the human-readable version.
 */

/** Coarse grouping so a client can triage without switching on every code. */
export type ErrorCodeCategory =
  | 'client'
  | 'auth'
  | 'authorization'
  | 'conflict'
  | 'idempotency'
  | 'dependency'
  | 'custody'
  | 'export'
  | 'backup'
  | 'rate_limit'
  | 'server';

/**
 * Recommended client behavior. Frontends should map these to UX rather than
 * re-deriving intent from the HTTP status.
 *
 * - `FIX_REQUEST` — payload/query invalid; show field errors, do not retry.
 * - `REAUTHENTICATE` — credentials missing/invalid; send the user to login.
 * - `REFRESH_TOKEN` — access token expired; refresh once, then re-auth.
 * - `REQUEST_ROLE` — authenticated but not permitted; hide/disable the action.
 * - `RETRY_WITH_BACKOFF` — safe to retry the same call after a delay.
 * - `RETRY_IDEMPOTENT` — retry only with the same idempotency key.
 * - `WAIT_AND_RETRY` — a resource is busy; retry after backoff.
 * - `CONTACT_SUPPORT` — show the `requestId` so support can trace it.
 */
export type FrontendAction =
  | 'FIX_REQUEST'
  | 'REAUTHENTICATE'
  | 'REFRESH_TOKEN'
  | 'REQUEST_ROLE'
  | 'RETRY_WITH_BACKOFF'
  | 'RETRY_IDEMPOTENT'
  | 'WAIT_AND_RETRY'
  | 'CONTACT_SUPPORT';

/** One catalog entry: everything a frontend needs to handle a code. */
export interface ErrorCodeCatalogEntry {
  /** Stable machine-readable code (mirrors the envelope `errorCode`). */
  code: ErrorCode;
  /** HTTP status the API returns with this code. */
  httpStatus: number;
  /** Coarse grouping for triage/UI. */
  category: ErrorCodeCategory;
  /** Whether retrying the identical request can ever succeed. */
  retryable: boolean;
  /** Recommended client behavior. */
  action: FrontendAction;
  /** Client-safe, non-leaking description of the failure. */
  message: string;
}

/** Entry metadata, keyed by code to force exhaustiveness at compile time. */
type CatalogSeed = Record<ErrorCode, Omit<ErrorCodeCatalogEntry, 'code'>>;

const SEED: CatalogSeed = {
  [ErrorCode.BAD_REQUEST]: {
    httpStatus: 400,
    category: 'client',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The request could not be understood.',
  },
  [ErrorCode.UNAUTHORIZED]: {
    httpStatus: 401,
    category: 'auth',
    retryable: false,
    action: 'REAUTHENTICATE',
    message: 'Authentication is required.',
  },
  [ErrorCode.FORBIDDEN]: {
    httpStatus: 403,
    category: 'authorization',
    retryable: false,
    action: 'REQUEST_ROLE',
    message: 'You are not allowed to perform this action.',
  },
  [ErrorCode.NOT_FOUND]: {
    httpStatus: 404,
    category: 'client',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The requested resource does not exist.',
  },
  [ErrorCode.CONFLICT]: {
    httpStatus: 409,
    category: 'conflict',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The request conflicts with the current state.',
  },
  [ErrorCode.UNPROCESSABLE_ENTITY]: {
    httpStatus: 422,
    category: 'client',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The request was well-formed but could not be processed.',
  },
  [ErrorCode.TOO_MANY_REQUESTS]: {
    httpStatus: 429,
    category: 'rate_limit',
    retryable: true,
    action: 'RETRY_WITH_BACKOFF',
    message: 'Too many requests; back off and retry.',
  },
  [ErrorCode.INTERNAL_ERROR]: {
    httpStatus: 500,
    category: 'server',
    retryable: true,
    action: 'CONTACT_SUPPORT',
    message: 'An unexpected server error occurred.',
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    httpStatus: 503,
    category: 'dependency',
    retryable: true,
    action: 'RETRY_WITH_BACKOFF',
    message: 'The service is temporarily unavailable.',
  },
  [ErrorCode.INVALID_CREDENTIALS]: {
    httpStatus: 401,
    category: 'auth',
    retryable: false,
    action: 'REAUTHENTICATE',
    message: 'The supplied credentials are invalid.',
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    httpStatus: 401,
    category: 'auth',
    retryable: false,
    action: 'REFRESH_TOKEN',
    message: 'The authentication token has expired.',
  },
  [ErrorCode.DELEGATE_REVOKED]: {
    httpStatus: 403,
    category: 'authorization',
    retryable: false,
    action: 'REQUEST_ROLE',
    message: 'The delegate authorization has been revoked.',
  },
  [ErrorCode.INSUFFICIENT_ROLE]: {
    httpStatus: 403,
    category: 'authorization',
    retryable: false,
    action: 'REQUEST_ROLE',
    message: 'The current role cannot perform this action.',
  },
  [ErrorCode.IDEMPOTENCY_KEY_REQUIRED]: {
    httpStatus: 400,
    category: 'idempotency',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'A client idempotency key is required for this request.',
  },
  [ErrorCode.IDEMPOTENCY_CONFLICT]: {
    httpStatus: 409,
    category: 'idempotency',
    retryable: false,
    action: 'RETRY_IDEMPOTENT',
    message:
      'The idempotency key was reused with a different payload; retry with the original request or a new key.',
  },
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: {
    httpStatus: 503,
    category: 'dependency',
    retryable: true,
    action: 'RETRY_WITH_BACKOFF',
    message:
      'A required dependency (Horizon/RPC/database) is unavailable; no write was applied.',
  },
  [ErrorCode.WRITE_REJECTED]: {
    httpStatus: 503,
    category: 'dependency',
    retryable: true,
    action: 'RETRY_WITH_BACKOFF',
    message: 'The write was rejected to protect data integrity.',
  },
  [ErrorCode.SHUTDOWN_IN_PROGRESS]: {
    httpStatus: 503,
    category: 'dependency',
    retryable: true,
    action: 'RETRY_WITH_BACKOFF',
    message:
      'The service is draining for a deploy or restart; retry once it is healthy again.',
  },
  [ErrorCode.KEY_DECRYPT_FAILED]: {
    httpStatus: 503,
    category: 'custody',
    retryable: false,
    action: 'CONTACT_SUPPORT',
    message:
      'Wallet key material could not be decrypted; the operation was refused.',
  },
  [ErrorCode.KEY_VERSION_UNSUPPORTED]: {
    httpStatus: 503,
    category: 'custody',
    retryable: false,
    action: 'CONTACT_SUPPORT',
    message: 'The wallet key version is not supported by this deployment.',
  },
  [ErrorCode.EXPORT_JOB_NOT_FOUND]: {
    httpStatus: 404,
    category: 'export',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The transaction export job was not found.',
  },
  [ErrorCode.EXPORT_NOT_READY]: {
    httpStatus: 409,
    category: 'export',
    retryable: true,
    action: 'WAIT_AND_RETRY',
    message: 'The export is still being generated.',
  },
  [ErrorCode.EXPORT_DOWNLOAD_FORBIDDEN]: {
    httpStatus: 403,
    category: 'export',
    retryable: false,
    action: 'REQUEST_ROLE',
    message: 'You are not allowed to download this export.',
  },
  [ErrorCode.EXPORT_DOWNLOAD_EXPIRED]: {
    httpStatus: 410,
    category: 'export',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The export download link has expired; request a new export.',
  },
  [ErrorCode.EXPORT_TOO_LARGE]: {
    httpStatus: 413,
    category: 'export',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The requested export exceeds the maximum allowed size.',
  },
  [ErrorCode.BACKUP_NOT_FOUND]: {
    httpStatus: 404,
    category: 'backup',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The backup was not found.',
  },
  [ErrorCode.BACKUP_NOT_READY]: {
    httpStatus: 409,
    category: 'backup',
    retryable: true,
    action: 'WAIT_AND_RETRY',
    message: 'The backup is not ready yet.',
  },
  [ErrorCode.BACKUP_IN_PROGRESS]: {
    httpStatus: 409,
    category: 'backup',
    retryable: true,
    action: 'WAIT_AND_RETRY',
    message: 'Another backup is already in progress.',
  },
  [ErrorCode.BACKUP_INTEGRITY_FAILED]: {
    httpStatus: 422,
    category: 'backup',
    retryable: false,
    action: 'CONTACT_SUPPORT',
    message: 'Backup integrity verification failed.',
  },
  [ErrorCode.RESTORE_FORBIDDEN]: {
    httpStatus: 403,
    category: 'backup',
    retryable: false,
    action: 'REQUEST_ROLE',
    message: 'You are not allowed to restore from this backup.',
  },
  [ErrorCode.RESTORE_CONFLICT]: {
    httpStatus: 409,
    category: 'backup',
    retryable: false,
    action: 'CONTACT_SUPPORT',
    message: 'The restore conflicts with the current state.',
  },
  [ErrorCode.RESTORE_IN_PROGRESS]: {
    httpStatus: 409,
    category: 'backup',
    retryable: true,
    action: 'WAIT_AND_RETRY',
    message: 'A restore is already in progress.',
  },
  [ErrorCode.RESTORE_POINT_INVALID]: {
    httpStatus: 422,
    category: 'backup',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'The requested restore point is invalid.',
  },
  [ErrorCode.VALIDATION_FAILED]: {
    httpStatus: 422,
    category: 'client',
    retryable: false,
    action: 'FIX_REQUEST',
    message: 'One or more fields failed validation.',
  },
  [ErrorCode.UNAUTHENTICATED]: {
    httpStatus: 401,
    category: 'auth',
    retryable: false,
    action: 'REAUTHENTICATE',
    message: 'Authentication is required.',
  },
  [ErrorCode.RATE_LIMITED]: {
    httpStatus: 429,
    category: 'rate_limit',
    retryable: true,
    action: 'RETRY_WITH_BACKOFF',
    message: 'The rate limit for this endpoint was exceeded.',
  },
};

/**
 * The catalog in stable declaration order. Frozen so a consumer cannot mutate
 * the shared instance.
 */
export const ERROR_CODE_CATALOG: readonly ErrorCodeCatalogEntry[] =
  Object.freeze(
    (Object.keys(SEED) as ErrorCode[]).map((code) =>
      Object.freeze({ code, ...SEED[code] }),
    ),
  );

/** Look up one entry, or `undefined` when the code is unknown. */
export function getErrorCodeEntry(
  code: string,
): ErrorCodeCatalogEntry | undefined {
  return ERROR_CODE_CATALOG.find((entry) => entry.code === (code as ErrorCode));
}

/**
 * Wire shape served at `GET /v1/error-codes`.
 *
 * `schemaVersion` is bumped only for a breaking change to the entry shape;
 * adding a code is not breaking.
 */
export interface ErrorCodeCatalogResponse {
  schemaVersion: number;
  codes: readonly ErrorCodeCatalogEntry[];
}

/** Build the public catalog payload. */
export function buildErrorCodeCatalogResponse(): ErrorCodeCatalogResponse {
  return { schemaVersion: 1, codes: ERROR_CODE_CATALOG };
}
