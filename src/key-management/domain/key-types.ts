import { BadRequestException } from '@nestjs/common';

export type KeyType = 'rsa' | 'ecdsa' | 'ed25519' | 'symmetric';

export type KeyOperation =
  | 'generate'
  | 'rotate'
  | 'revoke'
  | 'import'
  | 'export'
  | 'sign'
  | 'verify';

export interface KeyAuditLogEntry {
  id: string;
  operation: KeyOperation;
  keyType: KeyType;
  timestamp: string;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export interface AuditLogQueryParams {
  limit?: number;
  operation?: KeyOperation;
  keyType?: KeyType;
  success?: boolean;
  startDate?: string;
  endDate?: string;
}

/**
 * Maximum number of audit log entries that may be requested in a single query.
 */
export const MAX_AUDIT_LOG_LIMIT = 500;

/**
 * Default number of audit log entries returned when no limit is supplied.
 */
export const DEFAULT_AUDIT_LOG_LIMIT = 100;

/**
 * Stable error codes returned by {@link normalizeAuditLogQueryParams}.
 */
export const AUDIT_LOG_QUERY_ERROR_CODES = {
  INVALID_LIMIT: 'AUDIT_LOG_INVALID_LIMIT',
  INVALID_DATE_RANGE: 'AUDIT_LOG_INVALID_DATE_RANGE',
} as const;

/**
 * Validate and normalize audit log query parameters.
 *
 * - `limit` must be a positive integer no greater than {@link MAX_AUDIT_LOG_LIMIT}.
 *   When omitted, {@link DEFAULT_AUDIT_LOG_LIMIT} is applied.
 * - When both `startDate` and `endDate` are supplied they must be valid ISO-8601
 *   timestamps with `startDate <= endDate`.
 *
 * Invalid input is rejected with a {@link BadRequestException} carrying a stable
 * error code so callers never silently receive an empty or unbounded result set.
 */
export function normalizeAuditLogQueryParams(
  params: AuditLogQueryParams = {},
): AuditLogQueryParams {
  const normalized: AuditLogQueryParams = { ...params };

  if (params.limit === undefined) {
    normalized.limit = DEFAULT_AUDIT_LOG_LIMIT;
  } else {
    if (
      !Number.isInteger(params.limit) ||
      params.limit <= 0 ||
      params.limit > MAX_AUDIT_LOG_LIMIT
    ) {
      throw new BadRequestException({
        code: AUDIT_LOG_QUERY_ERROR_CODES.INVALID_LIMIT,
        message: `limit must be a positive integer no greater than ${MAX_AUDIT_LOG_LIMIT}`,
      });
    }
    normalized.limit = params.limit;
  }

  const start = params.startDate;
  const end = params.endDate;

  if (start !== undefined || end !== undefined) {
    const startTime = start !== undefined ? parseIsoTimestamp(start) : undefined;
    const endTime = end !== undefined ? parseIsoTimestamp(end) : undefined;

    if (startTime === undefined && start !== undefined) {
      throw invalidDateRange(`startDate must be a valid ISO-8601 timestamp`);
    }
    if (endTime === undefined && end !== undefined) {
      throw invalidDateRange(`endDate must be a valid ISO-8601 timestamp`);
    }
    if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
      throw invalidDateRange('startDate must not be later than endDate');
    }
  }

  return normalized;
}

function invalidDateRange(message: string): BadRequestException {
  return new BadRequestException({
    code: AUDIT_LOG_QUERY_ERROR_CODES.INVALID_DATE_RANGE,
    message,
  });
}

/**
 * Parse a strict ISO-8601 timestamp, returning `undefined` when invalid.
 */
function parseIsoTimestamp(value: string): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  if (!ISO_8601.test(value)) {
    return undefined;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}
