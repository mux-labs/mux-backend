/**
 * Correlation-id plumbing for logs, error envelopes, and outbound webhooks
 * (#927).
 *
 * A single inbound `X-Request-ID` must be resolvable by every layer so an
 * operator can follow one request from the access log, through the error
 * envelope, into the webhook the request caused. This module owns that
 * contract in one place; the logging middleware, the exception filter, and
 * the webhook dispatcher all read from it instead of re-deriving it.
 *
 * Invariants:
 *
 * - **Fail-safe, not fail-open on trust.** A client-supplied id is reused only
 *   when it is short, opaque, and log-safe (see `resolveRequestId`); anything
 *   else is replaced with a fresh UUID so a hostile header cannot forge a log
 *   line or a metric label.
 * - **Never secret-bearing.** The correlation id is derived from a header the
 *   client controls, so it is length-bounded and character-restricted. It is
 *   safe to log, to echo, and to place in a metric label.
 * - **Outbound propagation.** The id travels to webhook subscribers in the
 *   `X-Request-Id` header and as `requestId` in the payload envelope, so a
 *   consumer can quote it in a support request.
 */

import { randomUUID } from 'crypto';
// Imported from the module itself rather than the `interceptors` barrel: that
// barrel only re-exports the interceptor classes, so pulling `resolveRequestId`
// from it yields `undefined` at runtime.
import {
  REQUEST_ID_HEADER,
  MAX_REQUEST_ID_LENGTH,
  resolveRequestId,
} from '../interceptors/request-id.interceptor';

// Re-exported so every layer imports correlation concerns from one module.
export { REQUEST_ID_HEADER, MAX_REQUEST_ID_LENGTH, resolveRequestId };

/** Header carrying the correlation id on an **outbound** webhook delivery. */
export const WEBHOOK_REQUEST_ID_HEADER = 'X-Request-Id';

/** Payload envelope key carrying the correlation id to webhook subscribers. */
export const WEBHOOK_REQUEST_ID_FIELD = 'requestId';

/** Minimum shape this module needs from an inbound Express request. */
export interface RequestLike {
  headers?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Read the correlation id already assigned to a request.
 *
 * Prefers the id stamped by {@link resolveRequestId} on `request.requestId` and
 * falls back to the raw header, then to a fresh UUID. Never returns an
 * untrusted value verbatim: the header is re-validated, so a caller cannot
 * smuggle a control character or an unbounded string into a log line by
 * setting `request.requestId` directly.
 */
export function getRequestId(request?: RequestLike | null): string {
  if (!request) {
    return randomUUID();
  }

  if (typeof request.requestId === 'string' && request.requestId.length > 0) {
    // Re-validate rather than trusting the attached value: it may have been
    // set by a handler, and logs must stay injection-proof.
    return resolveRequestId(request.requestId);
  }

  const raw =
    request.headers?.['x-request-id'] ??
    request.headers?.['X-Request-ID'] ??
    request.headers?.['X-Request-Id'];
  // `raw` is `unknown`: a hostile client controls the header entirely, so the
  // value is narrowed explicitly rather than trusted as a string.
  const candidate: unknown = Array.isArray(raw) ? raw[0] : raw;

  return resolveRequestId(candidate);
}

/**
 * Correlation id for work that is *not* tied to a live request — a background
 * job, a queue drain, a retry. Always generated server-side, never derived
 * from a header, so a job's id cannot be spoofed by a webhook replay.
 */
export function newCorrelationId(prefix = 'job'): string {
  return `${prefix}-${randomUUID()}`;
}

/** Options for stamping a correlation id onto an outbound webhook delivery. */
export interface WebhookCorrelationInput {
  /**
   * Correlation id of the request that caused the event. Omit for events
   * raised by a background job — a server-side id is generated instead so the
   * delivery is still traceable.
   */
  requestId?: string;
  /** Job label used when generating an id for non-request-driven events. */
  jobPrefix?: string;
}

/** Headers added to an outbound webhook request. Never contains secrets. */
export type WebhookCorrelationHeaders = Record<string, string>;

/**
 * Headers for an outbound webhook delivery carrying the correlation id.
 *
 * The id is only ever added in its sanitized form; an untrusted value is
 * replaced by a server-generated one, so a webhook consumer can never be
 * handed a header containing injected control characters.
 */
export function buildWebhookCorrelationHeaders(
  input: WebhookCorrelationInput = {},
): WebhookCorrelationHeaders {
  const requestId =
    input.requestId !== undefined
      ? resolveRequestId(input.requestId)
      : newCorrelationId(input.jobPrefix ?? 'event');

  return { [WEBHOOK_REQUEST_ID_HEADER]: requestId };
}

/**
 * Envelope written around an outbound webhook payload.
 *
 * `requestId` is added alongside (never in place of) the caller's fields, and
 * the value is sanitized. Signing covers the exact bytes sent, so the id must
 * be computed **before** the HMAC is taken.
 */
export function withWebhookCorrelation<T extends Record<string, unknown>>(
  payload: T,
  input: WebhookCorrelationInput = {},
): T & { [WEBHOOK_REQUEST_ID_FIELD]: string } {
  const headers = buildWebhookCorrelationHeaders(input);
  const requestId = headers[WEBHOOK_REQUEST_ID_HEADER];

  return {
    ...payload,
    [WEBHOOK_REQUEST_ID_FIELD]: requestId,
  };
}
