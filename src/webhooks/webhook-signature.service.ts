import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  MAX_SIGNATURE_HEADER_BYTES,
  MAX_SIGNATURE_TOLERANCE_SECONDS,
  WebhookVerifyErrorCode,
} from './webhook-signature.model';
import type { WebhookVerifyErrorCode as WebhookVerifyErrorCodeType } from './webhook-signature.model';

/** A parsed, but not yet verified, `X-Webhook-Signature` value. */
export interface ParsedWebhookSignature {
  /** Signed timestamp, in seconds since the epoch. */
  timestamp: number;
  /** Lowercase hex HMAC-SHA256 digest. */
  signature: string;
}

/** Everything `verify` needs. Nothing here is ever logged verbatim. */
export interface WebhookVerificationRequest {
  /** Raw header value, e.g. `t=1700000000,v1=<hex>`. */
  header?: string | null;
  /** The exact bytes that were signed. */
  payload: string;
  /** Signing secret. Absent/blank means fail closed. */
  secret?: string | null;
  /** Current time in seconds, for deterministic tests. */
  nowSeconds?: number;
  /** Replay window override; must be positive and within the ceiling. */
  toleranceSeconds?: number;
}

/**
 * Error raised for every verification failure.
 *
 * Carries a stable `code` so callers branch on the reason, and a fixed,
 * client-safe `message` that never echoes the presented signature, the secret,
 * or the payload.
 */
export class WebhookVerificationError extends Error {
  readonly code: WebhookVerifyErrorCodeType;

  constructor(code: WebhookVerifyErrorCodeType, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

/**
 * Verifies inbound Mux webhook signatures.
 *
 * Invariants:
 *
 * 1. **Constant-time comparison.** The presented digest is compared with
 *    `crypto.timingSafeEqual` over equal-length buffers. A byte-by-byte `===`
 *    leaks the correct prefix length through response timing, which is exactly
 *    what an attacker needs to forge a signature one byte at a time. Buffers of
 *    differing length are rejected before comparison rather than being padded,
 *    so a length mismatch can never become a short-circuit.
 * 2. **Fail closed on a missing secret.** A deployment with no signing secret
 *    rejects every signature. There is no "skip verification" path and no
 *    fallback credential: an unset secret must never mean "accept anything".
 * 3. **Bounded replay window.** A signed timestamp outside
 *    `toleranceSeconds` is refused, so a captured header cannot be replayed
 *    indefinitely. Timestamps in the future are refused too — a forged
 *    signature with `t=now+1h` would otherwise stay valid for an hour.
 * 4. **Bounded input.** The raw header is size-capped before any parsing, so
 *    an oversized header costs a comparison, not a regex scan of attacker data.
 * 5. **No secret leakage.** Errors, logs, and metrics carry the stable code
 *    and the correlation id only. The secret, the presented digest, and the
 *    payload never appear in a log line, a metric label, or an error body.
 * 6. **Observable.** Every outcome increments a counter, so a spike in
 *    `mismatches` or `stale` is visible without reading payloads.
 */
@Injectable()
export class WebhookSignatureService {
  private readonly logger = new Logger(WebhookSignatureService.name);

  constructor(private readonly metrics: MetricsService) {}

  /** Computes the header value Mux would send for `payload`. */
  sign(
    secret: string,
    payload: string,
    timestampSeconds: number = Math.floor(Date.now() / 1000),
  ): string {
    const signature = this.digest(secret, payload, timestampSeconds);
    return `t=${timestampSeconds},v1=${signature}`;
  }

  /**
   * Verifies a presented signature.
   *
   * @throws WebhookVerificationError with a stable code on every failure path.
   */
  verify(request: WebhookVerificationRequest): ParsedWebhookSignature {
    const correlationId = `whv-${Date.now().toString(36)}`;
    const secret = request.secret;

    if (typeof secret !== 'string' || secret.trim().length === 0) {
      // Fail closed: without a secret there is nothing to verify against.
      this.fail(
        WebhookVerifyErrorCode.SECRET_UNAVAILABLE,
        'Webhook signing secret is not configured',
        correlationId,
        'secret_unavailable',
      );
    }

    const header = request.header;
    if (typeof header !== 'string' || header.length === 0) {
      this.fail(
        WebhookVerifyErrorCode.MISSING_SIGNATURE,
        'Missing webhook signature header',
        correlationId,
        'missing',
      );
    }

    if (Buffer.byteLength(header, 'utf8') > MAX_SIGNATURE_HEADER_BYTES) {
      this.fail(
        WebhookVerifyErrorCode.HEADER_TOO_LARGE,
        'Webhook signature header is too large',
        correlationId,
        'header_too_large',
      );
    }

    const parsed = this.parse(header);
    if (!parsed) {
      this.fail(
        WebhookVerifyErrorCode.MALFORMED_HEADER,
        'Malformed webhook signature header',
        correlationId,
        'malformed',
      );
    }

    const now = request.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance =
      request.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
    if (
      !Number.isFinite(tolerance) ||
      tolerance <= 0 ||
      tolerance > MAX_SIGNATURE_TOLERANCE_SECONDS
    ) {
      this.fail(
        WebhookVerifyErrorCode.INVALID_ARGUMENT,
        'Invalid signature tolerance',
        correlationId,
        'invalid_tolerance',
      );
    }

    // Replay window: reject both stale and not-yet-valid timestamps.
    if (Math.abs(now - parsed.timestamp) > tolerance) {
      this.fail(
        WebhookVerifyErrorCode.TIMESTAMP_OUT_OF_TOLERANCE,
        'Webhook signature timestamp outside accepted window',
        correlationId,
        'out_of_tolerance',
      );
    }

    const expected = Buffer.from(
      this.digest(secret, request.payload, parsed.timestamp),
      'hex',
    );
    const presented = Buffer.from(parsed.signature, 'hex');

    // Equal-length buffers are the precondition of timingSafeEqual. A
    // length mismatch is a mismatch; it is never short-circuited as "equal".
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    ) {
      this.fail(
        WebhookVerifyErrorCode.SIGNATURE_MISMATCH,
        'Webhook signature does not match',
        correlationId,
        'mismatch',
      );
    }

    this.metrics.incrementCounter('webhook_signature_verified');
    this.logger.debug(
      `webhook.verify ok ts=${parsed.timestamp} correlationId=${correlationId}`,
    );
    return parsed;
  }

  /** Splits `t=<ts>,v1=<hex>`; returns null when the shape is not exact. */
  private parse(header: string): ParsedWebhookSignature | null {
    const match = /^t=(\d{1,20}),v1=([0-9a-f]{64})$/.exec(header.trim());
    if (!match) {
      return null;
    }
    return {
      timestamp: Number.parseInt(match[1], 10),
      signature: match[2],
    };
  }

  private digest(
    secret: string,
    payload: string,
    timestampSeconds: number,
  ): string {
    return createHmac('sha256', secret)
      .update(`${timestampSeconds}.${payload}`)
      .digest('hex');
  }

  /**
   * Records the failure and throws. Every rejection path funnels through here
   * so metrics and logging can never be skipped for a new failure mode.
   */
  private fail(
    code: WebhookVerifyErrorCodeType,
    message: string,
    correlationId: string,
    metric: string,
  ): never {
    this.metrics.incrementCounter(`webhook_signature_${metric}`);
    this.logger.warn(
      `webhook.verify rejected code=${code} correlationId=${correlationId}`,
    );
    throw new WebhookVerificationError(code, message);
  }
}
