import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import {
  RATE_LIMITED_ERROR_CODE,
  RateLimitPolicy,
  RateLimitTier,
  resolveRateLimitPolicy,
  resolveRateLimitTier,
} from './rate-limit.policy';

/**
 * Marks a route as money- or key-sensitive.
 *
 * Retained as an explicit, reviewable statement of intent on routes that move
 * money or touch key material. Path-based classification in
 * `rate-limit.policy.ts` is the backstop that guarantees such a route is
 * bounded even if this decorator is forgotten; the decorator lets a route be
 * marked ahead of the classifier catching up.
 */
export const IS_SENSITIVE_ENDPOINT = 'isSensitiveEndpoint';
export const SensitiveEndpoint = () => SetMetadata(IS_SENSITIVE_ENDPOINT, true);

/** One tracked window for a single (tier, subject) pair. */
interface Window {
  /** Requests counted in the current window. */
  count: number;
  /** Epoch ms at which the window resets. */
  resetAt: number;
}

/** The request shape the guard reads. */
interface RateLimitedRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  apiKey?: { id?: string };
  ip?: string;
  socket?: { remoteAddress?: string };
  set?: (name: string, value: string) => void;
}

/**
 * Maximum number of tracked subjects, per tier.
 *
 * Bounded so a flood of distinct client IPs on the IP-keyed auth tier cannot
 * grow memory without limit. When the cap is hit the least-recently-seen entry
 * is evicted, which costs that caller a fresh window rather than a refusal.
 */
export const MAX_TRACKED_SUBJECTS = 10_000;

/**
 * Global rate-limit guard enforcing the auth/payments tier strategy (#926).
 *
 * Before this, the guard counted every caller in one undifferentiated bucket
 * keyed on the raw `Authorization` header, so:
 *
 * - a caller with no `Authorization` header — the credential-stuffing case,
 *   and the only shape in which `/auth/*` is reached — shared a single
 *   `'anonymous'` counter with every other anonymous caller in the process;
 * - the `RATE_LIMITED` contract documented in `docs/RATE-LIMITING.md` did not
 *   exist; refusals carried a different code; and
 * - limits were fixed constants, ignoring both the tier policy and any
 *   configuration.
 *
 * Invariants:
 *
 * 1. **The policy module decides the tier; the guard only enforces it.** The
 *    limit, window, and keying come from `resolveRateLimitPolicy`, so a limit
 *    tightened in configuration is tightened here too.
 * 2. **IP-keyed credential surface.** The `auth` tier is keyed on the client
 *    IP because no API key exists yet at `/auth/*`; every other tier is keyed
 *    on the server-resolved API-key id.
 * 3. **No credential is ever stored or logged.** The API-key tier is keyed on
 *    the *id* the server resolved, never on presented key material. A request
 *    with no resolved key falls back to its own address rather than to a
 *    shared constant bucket, so one caller cannot exhaust another's budget.
 * 4. **Deny-by-default.** Every request is classified — an unrecognised path
 *    lands in `default` — so no route is silently unthrottled, and a malformed
 *    limit falls back to the tier default rather than to "unlimited".
 * 5. **Stable, non-leaking refusal.** `429` with `RATE_LIMITED`, the tier
 *    name, `Retry-After`, and the standard `X-RateLimit-*` headers. The
 *    subject key never appears in the response.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  /** Per-tier windows, so one tier's traffic cannot evict another's. */
  private readonly windows = new Map<RateLimitTier, Map<string, Window>>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    const policy = resolveRateLimitPolicy(
      resolveRateLimitTier(this.readPath(request)),
    );

    const subject = this.resolveSubject(request, policy.keyedByIp);
    const now = Date.now();
    const window = this.consume(policy.tier, subject, policy.windowMs, now);

    if (window.count > policy.limit) {
      this.refuse(request, policy, window.resetAt, now);
    }

    this.setRateLimitHeaders(request, policy.limit, window);
    return true;
  }

  /**
   * Path used for tier classification. Query strings and trailing slashes are
   * normalized inside `resolveRateLimitTier`.
   */
  private readPath(request: RateLimitedRequest): string {
    return request.originalUrl ?? request.url ?? request.path ?? '';
  }

  /**
   * Resolve the bucket a request counts against.
   *
   * Never returns a shared constant: two unauthenticated callers from
   * different hosts must not consume one budget, which is exactly the failure
   * mode of the previous `'anonymous'` key.
   */
  private resolveSubject(
    request: RateLimitedRequest,
    keyedByIp: boolean,
  ): string {
    if (!keyedByIp) {
      const apiKeyId = request.apiKey?.id;
      if (typeof apiKeyId === 'string' && apiKeyId.length > 0) {
        return `key:${apiKeyId}`;
      }
    }

    return `ip:${this.readClientIp(request)}`;
  }

  /**
   * Client address used for IP-keyed subjects.
   *
   * Prefers the socket's remote address over headers the client controls: a
   * spoofable `X-Forwarded-For` would let an attacker mint a fresh budget per
   * request and defeat the tier entirely. Deployments behind a trusted proxy
   * should additionally terminate the limit at the proxy.
   */
  private readClientIp(request: RateLimitedRequest): string {
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }
  /**
   * Count one request against a sliding window, creating or resetting it as
   * needed. Returns the window *after* counting, so the caller compares
   * `count > limit`.
   */
  private consume(
    tier: RateLimitTier,
    subject: string,
    windowMs: number,
    now: number,
  ): Window {
    let tierWindows = this.windows.get(tier);
    if (!tierWindows) {
      tierWindows = new Map<string, Window>();
      this.windows.set(tier, tierWindows);
    }

    const existing = tierWindows.get(subject);
    const window =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + windowMs };

    window.count += 1;
    tierWindows.set(subject, window);

    if (tierWindows.size > MAX_TRACKED_SUBJECTS) {
      this.evictOldest(tierWindows);
    }

    return window;
  }

  /** Evict the least-recently-inserted subject when the cap is exceeded. */
  private evictOldest(tierWindows: Map<string, Window>): void {
    const oldest = tierWindows.keys().next();
    if (!oldest.done) {
      tierWindows.delete(oldest.value);
    }
  }

  /**
   * Reject with a stable, actionable contract. The limit is a policy value,
   * not a secret, and the subject key is never echoed.
   */
  private refuse(
    request: RateLimitedRequest,
    policy: RateLimitPolicy,
    resetAt: number,
    now: number,
  ): never {
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));

    this.setHeader(request, 'Retry-After', String(retryAfterSeconds));
    this.setHeader(request, 'X-RateLimit-Limit', String(policy.limit));
    this.setHeader(request, 'X-RateLimit-Remaining', '0');
    this.setHeader(
      request,
      'X-RateLimit-Reset',
      String(Math.ceil(resetAt / 1000)),
    );

    throw new HttpException(
      {
        errorCode: RATE_LIMITED_ERROR_CODE,
        message: 'Rate limit exceeded. Please try again later.',
        tier: policy.tier,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private setRateLimitHeaders(
    request: RateLimitedRequest,
    limit: number,
    window: Window,
  ): void {
    this.setHeader(request, 'X-RateLimit-Limit', String(limit));
    this.setHeader(
      request,
      'X-RateLimit-Remaining',
      String(Math.max(0, limit - window.count)),
    );
    this.setHeader(
      request,
      'X-RateLimit-Reset',
      String(Math.ceil(window.resetAt / 1000)),
    );
  }

  private setHeader(
    request: RateLimitedRequest,
    name: string,
    value: string,
  ): void {
    request.set?.(name, value);
  }
}
