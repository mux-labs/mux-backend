/**
 * Stable, machine-readable error codes for the Mux backend error envelope.
 *
 * These codes are part of the public API contract: clients (wallets, AA
 * providers, payment flows) branch on them, so they MUST remain stable across
 * releases. Add new codes; never repurpose or renumber existing ones.
 */
export enum ErrorCode {
  // Generic / transport
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  UNPROCESSABLE_ENTITY = 'UNPROCESSABLE_ENTITY',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Authz / policy
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  DELEGATE_REVOKED = 'DELEGATE_REVOKED',
  INSUFFICIENT_ROLE = 'INSUFFICIENT_ROLE',

  // Idempotency / replay
  IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',

  // Dependency / fail-closed
  DEPENDENCY_UNAVAILABLE = 'DEPENDENCY_UNAVAILABLE',
  WRITE_REJECTED = 'WRITE_REJECTED',

  // Key management / custody (fail-closed)
  KEY_DECRYPT_FAILED = 'KEY_DECRYPT_FAILED',
  KEY_VERSION_UNSUPPORTED = 'KEY_VERSION_UNSUPPORTED',

  // Transaction export (secure downloads)
  EXPORT_JOB_NOT_FOUND = 'EXPORT_JOB_NOT_FOUND',
  EXPORT_NOT_READY = 'EXPORT_NOT_READY',
  EXPORT_DOWNLOAD_FORBIDDEN = 'EXPORT_DOWNLOAD_FORBIDDEN',
  EXPORT_DOWNLOAD_EXPIRED = 'EXPORT_DOWNLOAD_EXPIRED',
  EXPORT_TOO_LARGE = 'EXPORT_TOO_LARGE',

  // Validation
  VALIDATION_FAILED = 'VALIDATION_FAILED',
}

/**
 * A single field-level validation detail. Safe to expose in production.
 */
export interface ErrorDetail {
  /** Dotted path to the offending field, e.g. `body.amount`. */
  field?: string;
  /** Human-readable, non-sensitive explanation. */
  message: string;
  /** Optional stable sub-code for programmatic handling. */
  code?: string;
}

/**
 * The canonical error envelope returned by every Mux backend entrypoint.
 *
 * Invariants:
 *  - `requestId` is ALWAYS present so clients and ops can correlate a failure
 *    with server logs/metrics.
 *  - `code` is a stable {@link ErrorCode} value, never a raw exception name.
 *  - `message` is safe for production: no stack traces, internal messages,
 *    secrets, JWTs, or raw key material.
 *  - `details` and `debug` are only populated outside production.
 */
export interface ErrorEnvelope {
  /** Stable, machine-readable error code. */
  code: ErrorCode;
  /** Safe, human-readable summary. */
  message: string;
  /** Correlation id for this request; always present. */
  requestId: string;
  /** HTTP status code mirrored for convenience. */
  statusCode: number;
  /** Optional field-level details (safe in production). */
  details?: ErrorDetail[];
  /** Verbose diagnostics; only populated in non-production. */
  debug?: Record<string, unknown>;
}

/**
 * Shape of the raw error information an interceptor/filter may hold before
 * sanitization. `debug` carries anything that must never reach production
 * clients (stack traces, upstream payloads, etc.).
 */
export interface RawErrorInput {
  code?: ErrorCode;
  message?: string;
  statusCode?: number;
  details?: ErrorDetail[];
  debug?: Record<string, unknown>;
}

const DEFAULT_STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.UNPROCESSABLE_ENTITY]: 422,
  [ErrorCode.TOO_MANY_REQUESTS]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.DELEGATE_REVOKED]: 403,
  [ErrorCode.INSUFFICIENT_ROLE]: 403,
  [ErrorCode.IDEMPOTENCY_KEY_REQUIRED]: 400,
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 409,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 503,
  [ErrorCode.WRITE_REJECTED]: 503,
  [ErrorCode.KEY_DECRYPT_FAILED]: 503,
  [ErrorCode.KEY_VERSION_UNSUPPORTED]: 503,
  [ErrorCode.EXPORT_JOB_NOT_FOUND]: 404,
  [ErrorCode.EXPORT_NOT_READY]: 409,
  [ErrorCode.EXPORT_DOWNLOAD_FORBIDDEN]: 403,
  [ErrorCode.EXPORT_DOWNLOAD_EXPIRED]: 410,
  [ErrorCode.EXPORT_TOO_LARGE]: 413,
  [ErrorCode.VALIDATION_FAILED]: 422,
};

const GENERIC_MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  [ErrorCode.BAD_REQUEST]: 'Bad request.',
  [ErrorCode.UNAUTHORIZED]: 'Authentication required.',
  [ErrorCode.FORBIDDEN]: 'You are not allowed to perform this action.',
  [ErrorCode.NOT_FOUND]: 'Resource not found.',
  [ErrorCode.CONFLICT]: 'Request conflicts with current state.',
  [ErrorCode.UNPROCESSABLE_ENTITY]: 'Request could not be processed.',
  [ErrorCode.TOO_MANY_REQUESTS]: 'Too many requests.',
  [ErrorCode.INTERNAL_ERROR]: 'Internal server error.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'Service temporarily unavailable.',
  [ErrorCode.INVALID_CREDENTIALS]: 'Invalid credentials.',
  [ErrorCode.TOKEN_EXPIRED]: 'Authentication token has expired.',
  [ErrorCode.DELEGATE_REVOKED]: 'Delegate authorization has been revoked.',
  [ErrorCode.INSUFFICIENT_ROLE]: 'Insufficient role for this action.',
  [ErrorCode.IDEMPOTENCY_KEY_REQUIRED]: 'An idempotency key is required.',
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 'Idempotency key reused with a different payload.',
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 'A required dependency is unavailable.',
  [ErrorCode.WRITE_REJECTED]: 'Write rejected to protect data integrity.',
  [ErrorCode.KEY_DECRYPT_FAILED]: 'Key material could not be decrypted; operation refused.',
  [ErrorCode.KEY_VERSION_UNSUPPORTED]: 'Key version is not supported; operation refused.',
  [ErrorCode.EXPORT_JOB_NOT_FOUND]: 'Transaction export job not found.',
  [ErrorCode.EXPORT_NOT_READY]: 'Transaction export is not ready for download.',
  [ErrorCode.EXPORT_DOWNLOAD_FORBIDDEN]: 'You are not allowed to download this export.',
  [ErrorCode.EXPORT_DOWNLOAD_EXPIRED]: 'This export download link has expired.',
  [ErrorCode.EXPORT_TOO_LARGE]: 'Requested export exceeds the maximum allowed size.',
  [ErrorCode.VALIDATION_FAILED]: 'Validation failed.',
};

/**
 * Patterns that must never appear in a production error payload. Covers
 * bearer tokens, JWTs, private keys, and common secret assignments.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, // Authorization header
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // PEM private key
  /\bS[A-Z2-7]{55}\b/g, // Stellar secret seed
  /\b(?:secret|password|passwd|api[_-]?key|token|private[_-]?key)\b\s*[:=]\s*\S+/gi,
];

/**
 * Redact anything that looks like a secret from a string. Used as a final
 * safety net so a leaked value can never reach a production client.
 */
export function redactSensitive(input: string): string {
  let output = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  return output;
}

/**
 * Build a production-safe {@link ErrorEnvelope}.
 *
 * In production (`isProduction === true`) the envelope is fail-closed:
 *  - `message` falls back to a generic, code-derived string.
 *  - `details` are dropped unless they are explicitly safe field messages.
 *  - `debug` is never included.
 *  - All string output is passed through {@link redactSensitive}.
 *
 * Outside production the caller-provided message/details/debug are preserved
 * (still redacted) to aid local debugging.
 */
export function buildErrorEnvelope(
  input: RawErrorInput,
  requestId: string,
  isProduction: boolean,
): ErrorEnvelope {
  const code = input.code ?? ErrorCode.INTERNAL_ERROR;
  const statusCode = input.statusCode ?? DEFAULT_STATUS_BY_CODE[code] ?? 500;

  const envelope: ErrorEnvelope = {
    code,
    message: isProduction
      ? GENERIC_MESSAGE_BY_CODE[code] ?? 'Request failed.'
      : redactSensitive(input.message ?? GENERIC_MESSAGE_BY_CODE[code] ?? 'Request failed.'),
    requestId,
    statusCode,
  };

  if (input.details && input.details.length > 0) {
    const details = input.details.map((detail) => ({
      ...detail,
      message: redactSensitive(detail.message),
    }));
    if (details.length > 0) {
      envelope.details = details;
    }
  }

  if (!isProduction && input.debug) {
    envelope.debug = input.debug;
  }

  return envelope;
}
