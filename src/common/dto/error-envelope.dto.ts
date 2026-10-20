import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Stable, machine-readable error codes returned by the API.
 *
 * These codes are part of the public contract: clients (wallets, AA
 * providers, payment flows) branch on them, so they must remain stable
 * across releases. Add new codes; never repurpose existing ones.
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
  /** The process is draining for shutdown and refuses new writes (#950). */
  SHUTDOWN_IN_PROGRESS = 'SHUTDOWN_IN_PROGRESS',

  // Key management / custody (fail-closed)
  KEY_DECRYPT_FAILED = 'KEY_DECRYPT_FAILED',
  KEY_VERSION_UNSUPPORTED = 'KEY_VERSION_UNSUPPORTED',
  /** Requested key type has no implementation and is refused (#1075). */
  KEY_TYPE_UNSUPPORTED = 'KEY_TYPE_UNSUPPORTED',

  // Transaction export (secure downloads)
  EXPORT_JOB_NOT_FOUND = 'EXPORT_JOB_NOT_FOUND',
  EXPORT_NOT_READY = 'EXPORT_NOT_READY',
  EXPORT_DOWNLOAD_FORBIDDEN = 'EXPORT_DOWNLOAD_FORBIDDEN',
  EXPORT_DOWNLOAD_EXPIRED = 'EXPORT_DOWNLOAD_EXPIRED',
  EXPORT_TOO_LARGE = 'EXPORT_TOO_LARGE',

  // Backup / restore (fail-closed)
  BACKUP_NOT_FOUND = 'BACKUP_NOT_FOUND',
  BACKUP_NOT_READY = 'BACKUP_NOT_READY',
  BACKUP_IN_PROGRESS = 'BACKUP_IN_PROGRESS',
  BACKUP_INTEGRITY_FAILED = 'BACKUP_INTEGRITY_FAILED',
  RESTORE_FORBIDDEN = 'RESTORE_FORBIDDEN',
  RESTORE_CONFLICT = 'RESTORE_CONFLICT',
  RESTORE_IN_PROGRESS = 'RESTORE_IN_PROGRESS',
  RESTORE_POINT_INVALID = 'RESTORE_POINT_INVALID',

  // Transactions
  /** Sender and receiver resolve to the same wallet; a self-payment is refused. */
  TRANSACTION_SELF_PAYMENT = 'TRANSACTION_SELF_PAYMENT',

  // Validation
  /** Request failed validation (bad/oversized payload, malformed input). */
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** Caller is not authenticated (missing/invalid/expired credentials). */
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  /** Rate limit exceeded for the caller/route. */
  RATE_LIMITED = 'RATE_LIMITED',
}

/**
 * Canonical error envelope returned for every failed request.
 *
 * `correlationId` is echoed from the inbound request (or generated) so that
 * operators can trace a failure across logs without exposing secrets or raw
 * key material. `message` is safe for clients; never include tokens, JWTs,
 * webhook secrets, or key material here.
 */
export class ErrorEnvelopeDto {
  @ApiProperty({
    description: 'Stable, machine-readable error code.',
    enum: ErrorCode,
    example: ErrorCode.FORBIDDEN,
  })
  code!: ErrorCode;

  @ApiProperty({
    description: 'Human-readable, client-safe error message.',
    example: 'Request is not permitted.',
  })
  message!: string;

  @ApiProperty({
    description:
      'Correlation id for tracing this request across logs and services.',
    example: '3f1c9b2e-8a4d-4c1e-9f2a-1b2c3d4e5f60',
  })
  correlationId!: string;

  @ApiPropertyOptional({
    description:
      'Optional structured details (e.g. field-level validation errors). Every ' +
      'message is redacted before it is returned to the client.',
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  details?: ErrorDetail[];

  @ApiPropertyOptional({
    description: 'HTTP status code mirrored for convenience.',
    example: 403,
  })
  statusCode?: number;

  @ApiPropertyOptional({
    description: 'Verbose diagnostics; only populated in non-production.',
    type: 'object',
    additionalProperties: true,
  })
  debug?: Record<string, unknown>;
}

/**
 * A single structured validation/detail entry attached to an error envelope.
 * `message` is redacted before it ever reaches a client.
 */
export interface ErrorDetail {
  /** Dotted path of the offending field, e.g. `body.amount`. */
  field?: string;
  /** Client-safe explanation of the specific problem. */
  message: string;
  /** Any additional non-sensitive context. */
  [key: string]: unknown;
}

/**
 * Placeholder substituted for any value whose key looks secret-bearing.
 */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Maximum length of a detail `message` before it is truncated. Keeps
 * accidental payload dumps from riding along in the envelope.
 */
export const MAX_DETAIL_MESSAGE_LENGTH = 500;

/**
 * Case-insensitive substrings that mark a detail key as secret-bearing.
 * Any key containing one of these is redacted wholesale.
 */
export const SECRET_KEY_DENYLIST: readonly string[] = [
  'token',
  'secret',
  'key',
  'authorization',
  'password',
  'seed',
];

/**
 * Matches a Stellar StrKey secret seed: `S` followed by 55 base32 chars.
 */
const STRKEY_SECRET_SEED_PATTERN = /S[A-Z2-7]{55}/g;

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SECRET_KEY_DENYLIST.some((needle) => normalized.includes(needle));
}

function redactMessage(message: string): string {
  const masked = message.replace(STRKEY_SECRET_SEED_PATTERN, REDACTED_PLACEHOLDER);
  if (masked.length > MAX_DETAIL_MESSAGE_LENGTH) {
    return masked.slice(0, MAX_DETAIL_MESSAGE_LENGTH);
  }
  return masked;
}

/**
 * Redact a list of error details before they are returned to a client.
 *
 * - Any key matching {@link SECRET_KEY_DENYLIST} (case-insensitive) has its
 *   value replaced with {@link REDACTED_PLACEHOLDER}.
 * - Any Stellar `S...` StrKey secret seed appearing in a `message` is masked.
 * - `message` is truncated to {@link MAX_DETAIL_MESSAGE_LENGTH} characters.
 *
 * The input array and its entries are never mutated; a new array of new
 * objects is returned.
 */
export function redactErrorDetails(details: ErrorDetail[]): ErrorDetail[] {
  return details.map((detail) => {
    const redacted: ErrorDetail = { ...detail };

    for (const key of Object.keys(redacted)) {
      if (isSecretKey(key)) {
        redacted[key] = REDACTED_PLACEHOLDER;
      }
    }

    if (typeof redacted.message === 'string') {
      redacted.message = redactMessage(redacted.message);
    }

    return redacted;
  });
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

/**
 * Canonical HTTP status for each error code. Exported so the frontend-facing
 * catalog (#949) can be drift-checked against the envelope builder in tests.
 */
export const DEFAULT_STATUS_BY_CODE: Record<ErrorCode, number> = {
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
  [ErrorCode.SHUTDOWN_IN_PROGRESS]: 503,
  [ErrorCode.KEY_DECRYPT_FAILED]: 503,
  [ErrorCode.KEY_VERSION_UNSUPPORTED]: 503,
  [ErrorCode.KEY_TYPE_UNSUPPORTED]: 503,
  [ErrorCode.EXPORT_JOB_NOT_FOUND]: 404,
  [ErrorCode.EXPORT_NOT_READY]: 409,
  [ErrorCode.EXPORT_DOWNLOAD_FORBIDDEN]: 403,
  [ErrorCode.EXPORT_DOWNLOAD_EXPIRED]: 410,
  [ErrorCode.EXPORT_TOO_LARGE]: 413,
  [ErrorCode.BACKUP_NOT_FOUND]: 404,
  [ErrorCode.BACKUP_NOT_READY]: 409,
  [ErrorCode.BACKUP_IN_PROGRESS]: 409,
  [ErrorCode.BACKUP_INTEGRITY_FAILED]: 422,
  [ErrorCode.RESTORE_FORBIDDEN]: 403,
  [ErrorCode.RESTORE_CONFLICT]: 409,
  [ErrorCode.RESTORE_IN_PROGRESS]: 409,
  [ErrorCode.RESTORE_POINT_INVALID]: 422,
  [ErrorCode.VALIDATION_FAILED]: 422,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.RATE_LIMITED]: 429,
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
  [ErrorCode.IDEMPOTENCY_CONFLICT]:
    'Idempotency key reused with a different payload.',
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 'A required dependency is unavailable.',
  [ErrorCode.WRITE_REJECTED]: 'Write rejected to protect data integrity.',
  [ErrorCode.SHUTDOWN_IN_PROGRESS]:
    'The service is shutting down and is not accepting new writes.',
  [ErrorCode.KEY_DECRYPT_FAILED]:
    'Key material could not be decrypted; operation refused.',
  [ErrorCode.KEY_VERSION_UNSUPPORTED]:
    'Key version is not supported; operation refused.',
  [ErrorCode.KEY_TYPE_UNSUPPORTED]:
    'Key type is not supported; operation refused.',
  [ErrorCode.EXPORT_JOB_NOT_FOUND]: 'Transaction export job not found.',
  [ErrorCode.EXPORT_NOT_READY]: 'Transaction export is not ready for download.',
  [ErrorCode.EXPORT_DOWNLOAD_FORBIDDEN]:
    'You are not allowed to download this export.',
  [ErrorCode.EXPORT_DOWNLOAD_EXPIRED]: 'This export download link has expired.',
  [ErrorCode.EXPORT_TOO_LARGE]: 'The requested export is too large.',
  [ErrorCode.BACKUP_NOT_FOUND]: 'Backup not found.',
  [ErrorCode.BACKUP_NOT_READY]: 'Backup is not ready.',
  [ErrorCode.BACKUP_IN_PROGRESS]: 'A backup is already in progress.',
  [ErrorCode.BACKUP_INTEGRITY_FAILED]: 'Backup integrity check failed.',
  [ErrorCode.RESTORE_FORBIDDEN]: 'You are not allowed to restore this backup.',
  [ErrorCode.RESTORE_CONFLICT]: 'Restore conflicts with current state.',
  [ErrorCode.RESTORE_IN_PROGRESS]: 'A restore is already in progress.',
  [ErrorCode.RESTORE_POINT_INVALID]: 'The restore point is invalid.',
  [ErrorCode.VALIDATION_FAILED]: 'Request failed validation.',
  [ErrorCode.UNAUTHENTICATED]: 'Authentication required.',
  [ErrorCode.RATE_LIMITED]: 'Too many requests.',
};

/**
 * Served error-code catalog (#949). Maps every `ErrorCode` to its canonical
 * HTTP status and client-safe message so the catalog-coverage test can assert
 * that no code is missing from the served contract.
 */
export const ERROR_CODE_CATALOG: Record<
  ErrorCode,
  { statusCode: number; message: string }
> = Object.fromEntries(
  (Object.values(ErrorCode) as ErrorCode[]).map((code) => [
    code,
    {
      statusCode: DEFAULT_STATUS_BY_CODE[code],
      message: GENERIC_MESSAGE_BY_CODE[code],
    },
  ]),
) as Record<ErrorCode, { statusCode: number; message: string }>;
