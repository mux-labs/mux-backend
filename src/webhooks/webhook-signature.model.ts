/**
 * Inbound webhook signature verification: the wire format and the rules for
 * accepting (or refusing) a signature.
 *
 * Mux signs outbound webhook deliveries with HMAC-SHA256 and presents the
 * result in the `X-Webhook-Signature` header as `t=<timestamp>,v1=<signature>`
 * (see README, "Webhooks"). Anything that verifies an inbound webhook — a
 * partner relay, a support tool, a future `/webhooks/inbound` route — must
 * share one verifier so the rules cannot drift between call sites.
 */

/** Header carrying the outbound signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

/**
 * Upper bound on the raw `t=...,v1=...` header value, in bytes.
 *
 * The header is attacker-controlled. Without a bound, a caller could send a
 * multi-megabyte header and force the verifier to allocate and regex-scan it
 * before rejecting it — a cheap way to burn CPU on a public entrypoint. The
 * longest legitimate header is a 10-digit timestamp, two separators, and a
 * 64-character hex digest, so 256 bytes is generous.
 */
export const MAX_SIGNATURE_HEADER_BYTES = 256;

/**
 * Default replay window, in seconds, for a signed delivery.
 *
 * The timestamp inside the signature bounds replay: a captured header stops
 * being accepted once it ages out. Five minutes matches the tolerance used by
 * Stripe and GitHub and is long enough for a receiver with a slow clock skew.
 */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Maximum accepted clock skew, in seconds, for a signed delivery.
 *
 * A larger window widens the replay surface; a smaller one breaks receivers
 * with a drifting clock. Beyond this ceiling the header is refused rather than
 * silently accepted with a looser policy than the deployment asked for.
 */
export const MAX_SIGNATURE_TOLERANCE_SECONDS = 900;

/**
 * Stable, machine-readable codes for verification failures.
 *
 * These are part of the public contract: callers and dashboards branch on the
 * code, never on the message. Add new codes; never repurpose one.
 */
export const WebhookVerifyErrorCode = {
  /** No signature header was presented. */
  MISSING_SIGNATURE: 'WEBHOOK_SIGNATURE_MISSING',
  /** The header is present but not a well-formed `t=..,v1=..` value. */
  MALFORMED_HEADER: 'WEBHOOK_SIGNATURE_MALFORMED',
  /** The header is larger than {@link MAX_SIGNATURE_HEADER_BYTES}. */
  HEADER_TOO_LARGE: 'WEBHOOK_SIGNATURE_HEADER_TOO_LARGE',
  /** No signing secret is configured or supplied; fail closed. */
  SECRET_UNAVAILABLE: 'WEBHOOK_SIGNATURE_SECRET_UNAVAILABLE',
  /** The signed timestamp is outside the accepted replay window. */
  TIMESTAMP_OUT_OF_TOLERANCE: 'WEBHOOK_SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE',
  /** The signature does not match the expected HMAC. */
  SIGNATURE_MISMATCH: 'WEBHOOK_SIGNATURE_MISMATCH',
  /** The caller's clock/tolerance arguments are not usable. */
  INVALID_ARGUMENT: 'WEBHOOK_VERIFY_INVALID_ARGUMENT',
} as const;

export type WebhookVerifyErrorCode =
  (typeof WebhookVerifyErrorCode)[keyof typeof WebhookVerifyErrorCode];
