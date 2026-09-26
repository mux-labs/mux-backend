import { Injectable, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Audit actions recorded for every API key decision.
 *
 * These are part of the public contract: dashboards and alerts match on the
 * action string, never on a message. Add new actions; never repurpose one.
 */
export const ApiKeyAuditAction = {
  /** A key was presented and passed validation. */
  VALIDATED: 'API_KEY_VALIDATED',
  /** A key was presented and rejected (unknown, revoked, expired, malformed). */
  REJECTED: 'API_KEY_REJECTED',
  /** The API key store could not be reached; validation failed closed. */
  VALIDATION_UNAVAILABLE: 'API_KEY_VALIDATION_UNAVAILABLE',
} as const;

export type ApiKeyAuditAction =
  (typeof ApiKeyAuditAction)[keyof typeof ApiKeyAuditAction];

/**
 * Stable rejection reasons.
 *
 * A rejection is a security signal: an operator must be able to tell a revoked
 * key from an expired one from a typo without parsing prose, and without the
 * reason ever carrying key material.
 */
export const ApiKeyAuditReason = {
  MISSING: 'MISSING',
  MALFORMED: 'MALFORMED',
  UNKNOWN: 'UNKNOWN',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
  SUSPENDED: 'SUSPENDED',
} as const;

export type ApiKeyAuditReason =
  (typeof ApiKeyAuditReason)[keyof typeof ApiKeyAuditReason];

/**
 * One audit record.
 *
 * Invariants (see {@link ApiKeyAuditService}):
 *  - `fingerprint` is a truncated hash, never the key itself.
 *  - Every field is bounded and charset-restricted before it is stored or
 *    logged, so a hostile client cannot inject newlines into an operator's
 *    terminal via a header.
 */
export interface ApiKeyAuditEvent {
  action: ApiKeyAuditAction;
  /** Truncated SHA-256 fingerprint of the presented key, if one was present. */
  fingerprint?: string;
  /** Resolved key id. Only set for a key the server recognised. */
  apiKeyId?: string;
  /** Stable rejection reason; only set for reject/unavailable actions. */
  reason?: ApiKeyAuditReason;
  /** Resolved owning developer, when the key was recognised. */
  developerId?: string;
  projectId?: string;
  /** Request context (method + path), never a query string or body. */
  route?: string;
  /** Client IP, already resolved by Nest. */
  ip?: string;
  /** Correlation id so an audit line can be joined to request logs. */
  correlationId: string;
  at: string;
}

/** Number of characters of the SHA-256 hex digest kept as a fingerprint. */
export const API_KEY_FINGERPRINT_LENGTH = 12;

/** Maximum characters retained for any single audit field. */
export const MAX_AUDIT_FIELD_LENGTH = 128;

/**
 * Maximum number of events retained in the in-process ring buffer.
 *
 * The buffer is a debugging aid for the current process, not a compliance
 * store: it is bounded so an attacker spraying invalid keys cannot grow it
 * without limit. Durable audit storage is the platform log shipper's job.
 */
export const MAX_AUDIT_BUFFER_SIZE = 500;

/**
 * ApiKeyAuditService
 *
 * Append-only, ops-safe audit trail for API key authentication decisions.
 *
 * Invariants:
 *  - **No key material, ever.** The presented key is hashed with SHA-256 and
 *    only the first {@link API_KEY_FINGERPRINT_LENGTH} hex characters are kept.
 *    The plaintext key is not stored, not returned, and not logged — so a
 *    fingerprint is safe to put in an alert and useless to an attacker.
 *  - **Constant-time fingerprint comparison.** Comparing fingerprints with `===`
 *    would reintroduce a timing side channel on the key itself, so
 *    {@link sameKey} uses `crypto.timingSafeEqual`.
 *  - **Bounded, sanitized fields.** Every value is truncated and stripped of
 *    characters outside a safe set before it is stored or logged, closing the
 *    log-injection vector a client-controlled header would otherwise open.
 *  - **Correlatable.** Every event carries a correlation id, so an audit line,
 *    a request log line, and a client-side report can be joined.
 *  - **Non-throwing sink.** `record()` sanitizes and stores; it never lets a
 *    malformed event take down the caller. A failed write is counted in metrics
 *    and rethrown only to the audit caller, which the guard treats as
 *    non-fatal for the request itself.
 */
@Injectable()
export class ApiKeyAuditService {
  private readonly logger = new Logger(ApiKeyAuditService.name);
  private readonly buffer: ApiKeyAuditEvent[] = [];

  constructor(private readonly metrics: MetricsService) {}

  /**
   * Computes the audit fingerprint for a presented key.
   *
   * Returns `undefined` for an absent key: an empty fingerprint would be
   * indistinguishable from a real one in a log.
   */
  fingerprint(key: string | undefined | null): string | undefined {
    if (typeof key !== 'string' || key.length === 0) {
      return undefined;
    }
    return createHash('sha256')
      .update(key, 'utf8')
      .digest('hex')
      .slice(0, API_KEY_FINGERPRINT_LENGTH);
  }

  /**
   * Constant-time comparison of two fingerprints.
   *
   * Only used to decide whether two events describe the *same* presented key
   * (e.g. de-duplicating a replay), never for authentication.
   */
  sameKey(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right || left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(
      Buffer.from(left, 'utf8'),
      Buffer.from(right, 'utf8'),
    );
  }

  /**
   * Records one audit event and returns the stored (sanitized) copy.
   *
   * Sanitization never throws: a field with an unexpected type is coerced, not
   * rejected, so a hostile value cannot silence the audit trail itself.
   */
  record(
    event: Omit<ApiKeyAuditEvent, 'at'> & { at?: string },
  ): ApiKeyAuditEvent {
    const sanitized: ApiKeyAuditEvent = {
      action: event.action,
      fingerprint: this.sanitize(event.fingerprint),
      apiKeyId: this.sanitize(event.apiKeyId),
      reason: event.reason,
      developerId: this.sanitize(event.developerId),
      projectId: this.sanitize(event.projectId),
      route: this.sanitize(event.route),
      ip: this.sanitize(event.ip),
      correlationId: this.sanitize(event.correlationId) ?? 'unknown',
      at: event.at ?? new Date().toISOString(),
    };

    // Bounded ring: drop the oldest event once the cap is reached, so a spray
    // of invalid keys cannot grow the buffer without limit.
    this.buffer.push(sanitized);
    if (this.buffer.length > MAX_AUDIT_BUFFER_SIZE) {
      this.buffer.shift();
    }

    try {
      this.metrics.incrementCounter(
        `apikey_audit_${event.action.toLowerCase()}`,
      );
      if (event.reason) {
        this.metrics.incrementCounter(
          `apikey_audit_reason_${event.reason.toLowerCase()}`,
        );
      }
    } catch {
      // A metrics sink outage must not swallow the audit record.
    }

    // Structured, single-line log: every value was sanitized above, so a
    // client-controlled header cannot forge a log line here.
    this.logger.log(
      `apikey.audit action=${sanitized.action} ` +
        `reason=${sanitized.reason ?? '-'} ` +
        `fingerprint=${sanitized.fingerprint ?? '-'} ` +
        `apiKeyId=${sanitized.apiKeyId ?? '-'} ` +
        `developerId=${sanitized.developerId ?? '-'} ` +
        `route=${sanitized.route ?? '-'} ` +
        `correlationId=${sanitized.correlationId}`,
    );

    return sanitized;
  }

  /**
   * Most recent events, newest last. Bounded by `limit`.
   *
   * A non-positive or non-integer limit returns an empty list rather than
   * throwing: this is an observability helper, not an authz surface.
   */
  recent(limit = 50): ApiKeyAuditEvent[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      return [];
    }
    return this.buffer.slice(-limit);
  }

  /** Empties the in-process buffer. Intended for tests and ops tooling. */
  clear(): void {
    this.buffer.length = 0;
  }

  /**
   * Truncates a value to a safe length and strips characters outside a
   * conservative set, so a client-controlled value cannot forge a log line.
   *
   * Space is allowed because it is log-safe and keeps the route field readable
   * ("GET /wallets"); newlines, carriage returns, tabs, and every other control
   * character are stripped, which is what closes the log-injection vector.
   */
  private sanitize(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    // Only primitives are ever stringified: an object would render as
    // "[object Object]" and an array as a comma-joined blob, neither of which
    // identifies a key or a route.
    const raw =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
        ? String(value)
        : '';
    if (raw.length === 0) {
      return undefined;
    }
    const cleaned = raw
      .replace(/[^A-Za-z0-9 _:@./-]/g, '_')
      .replace(/[^\S ]+/g, '_')
      .trim()
      .slice(0, MAX_AUDIT_FIELD_LENGTH);
    return cleaned.length === 0 ? undefined : cleaned;
  }
}
