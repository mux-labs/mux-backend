import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Stable, typed error codes for the webhook URL allowlist.
 *
 * Clients and ops dashboards branch on these codes, not on message text.
 * Add new codes; never repurpose an existing one.
 */
export const WebhookUrlErrorCode = {
  /** The URL could not be parsed, or is not an absolute http(s) URL. */
  INVALID_URL: 'WEBHOOK_URL_INVALID',
  /** Scheme is not https. Plaintext delivery is refused. */
  SCHEME_NOT_ALLOWED: 'WEBHOOK_URL_SCHEME_NOT_ALLOWED',
  /** Host is a literal IP in a blocked range (private/loopback/link-local/...). */
  BLOCKED_HOST: 'WEBHOOK_URL_BLOCKED_HOST',
  /** Non-standard port, or a port that is blocked explicitly. */
  PORT_NOT_ALLOWED: 'WEBHOOK_URL_PORT_NOT_ALLOWED',
  /** Host is not on the operator-configured allowlist. */
  NOT_ALLOWLISTED: 'WEBHOOK_URL_NOT_ALLOWLISTED',
} as const;

export type WebhookUrlErrorCode =
  (typeof WebhookUrlErrorCode)[keyof typeof WebhookUrlErrorCode];

/** Result of {@link WebhookUrlAllowlistService.assertAllowed}. */
export interface WebhookUrlDecision {
  /** Normalized `host` (lowercased, no trailing dot). */
  host: string;
  /** Effective port, always explicit. */
  port: number;
  /** Path only, so a query string can never leak into logs. */
  redactedPath: string;
}

/** Env var holding the operator's host allowlist. */
export const WEBHOOK_ALLOWED_HOSTS_ENV = 'WEBHOOK_ALLOWED_HOSTS';

/** Env var holding extra blocked ports (comma separated, e.g. "25,8080"). */
export const WEBHOOK_BLOCKED_PORTS_ENV = 'WEBHOOK_BLOCKED_PORTS';

/** Env var that can disable outbound webhooks entirely (kill-switch). */
export const WEBHOOK_SSRF_PROTECTION_ENABLED_ENV =
  'WEBHOOK_SSRF_PROTECTION_ENABLED';

/**
 * Only these ports are ever accepted. 443 is the default; 8443 is the
 * conventional alternative for HTTPS listeners. Anything else — notably 25
 * (SMTP), 22 (SSH) and 6379 (Redis) — is a classic SSRF pivot target.
 */
export const WEBHOOK_ALLOWED_PORTS: ReadonlySet<number> = new Set([443, 8443]);

/** Longest accepted URL. Bounds the work a single registration can cost. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/**
 * IP literals the backend must never call: loopback, RFC1918 private space,
 * link-local (incl. the 169.254.169.254 cloud metadata address), carrier-grade
 * NAT, unique-local IPv6, IPv4-mapped IPv6, and the "this host" ranges.
 */
const BLOCKED_IPV4_PATTERNS: RegExp[] = [
  /^127\./, // loopback
  /^10\./, // private
  /^192\.168\./, // private
  /^169\.254\./, // link-local + cloud metadata
  /^172\.(1[6-9]|2\d|3[01])\./, // private
  /^0\./, // "this host"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
];

function isBlockedIpv4(host: string): boolean {
  return BLOCKED_IPV4_PATTERNS.some((re) => re.test(host));
}

function isBlockedIpv6(host: string): boolean {
  // Bracketed form, e.g. [::1].
  const inner =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!inner.includes(':')) {
    return false;
  }
  const lower = inner.toLowerCase();
  if (lower === '::' || lower === '::1') {
    return true;
  }
  if (
    lower.startsWith('fe80') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd')
  ) {
    // Link-local (fe80::/10) and unique-local (fc00::/7).
    return true;
  }
  // IPv4-mapped/compatible IPv6 inherits the IPv4 rules. `new URL()`
  // normalizes `[::ffff:127.0.0.1]` to the hex form `[::ffff:7f00:1]`, so both
  // spellings have to be recognized.
  const mapped = lower.match(
    /^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/,
  );
  if (mapped) {
    if (mapped[1]) {
      return isBlockedIpv4(mapped[1]);
    }
    const high = Number.parseInt(mapped[2], 16);
    const low = Number.parseInt(mapped[3], 16);
    return isBlockedIpv4(
      `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
    );
  }
  return false;
}

/** True when the host is an IP literal rather than a DNS name. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[')) {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Validates outbound webhook URLs against an SSRF allowlist.
 *
 * ## Invariants
 *
 * 1. **Deny by default.** A URL is only accepted when its host is on the
 *    operator's allowlist. An empty `WEBHOOK_ALLOWED_HOSTS` accepts nothing,
 *    so a misconfigured deploy cannot be turned into an internal prober.
 * 2. **https only.** Plaintext http is refused, so webhook payloads and their
 *    HMAC signature cannot be read off the wire.
 * 3. **No private/loopback/link-local targets.** A literal IP in a blocked
 *    range is rejected before any socket is opened, which is what stops
 *    `169.254.169.254` (cloud metadata) credential theft.
 * 4. **No credential-bearing URLs.** `user:pass@host` is rejected outright.
 * 5. **Fixed port set.** Only 443/8443 (plus any extra deny-listed ports) —
 *    no SMTP/SSH/Redis pivots.
 * 6. **Bounded work.** URLs longer than 2048 characters are rejected before
 *    parsing, so an adversarial registration cannot amplify CPU use.
 * 7. **Kill-switch.** `WEBHOOK_SSRF_PROTECTION_ENABLED=false` refuses every
 *    registration and delivery attempt. There is deliberately no "allow all"
 *    bypass: disabling the protection disables webhooks.
 *
 * DNS names are *not* resolved here on purpose: validation is synchronous and
 * offline so a registration cannot be turned into a DNS-based timing or
 * exfiltration oracle. Operators that need DNS-level pinning should allowlist
 * the resolved host.
 */
@Injectable()
export class WebhookUrlAllowlistService {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly blockedPorts: ReadonlySet<number>;
  private readonly configService: ConfigService | undefined;

  constructor(configService?: ConfigService) {
    this.configService = configService;
    this.allowedHosts = parseHostList(
      readEnv(configService, WEBHOOK_ALLOWED_HOSTS_ENV),
    );
    this.blockedPorts = new Set([
      ...parsePortList(readEnv(configService, WEBHOOK_BLOCKED_PORTS_ENV)),
    ]);
  }

  /**
   * Whether outbound webhook registration/delivery is permitted at all.
   *
   * Reads the injected config first, then the process env, so the same answer
   * is produced whether or not the service was constructed with a ConfigService.
   */
  isProtectionEnabled(configService?: ConfigService): boolean {
    const raw = readEnv(
      configService ?? this.configService,
      WEBHOOK_SSRF_PROTECTION_ENABLED_ENV,
    );
    if (raw === undefined || raw === '') {
      // Fail-closed: protection is on unless an operator explicitly disables it.
      return true;
    }
    const normalized = raw.trim().toLowerCase();
    return !(
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'off'
    );
  }

  /** The configured allowlist, for ops visibility. Never contains secrets. */
  describeAllowlist(): { allowedHosts: string[]; allowedPorts: number[] } {
    return {
      allowedHosts: [...this.allowedHosts].sort(),
      allowedPorts: [...WEBHOOK_ALLOWED_PORTS].sort((a, b) => a - b),
    };
  }

  /**
   * Throws when `url` may not be used as a webhook target.
   *
   * @throws Error with a `code` from {@link WebhookUrlErrorCode}.
   */
  assertAllowed(
    url: unknown,
    configService?: ConfigService,
  ): WebhookUrlDecision {
    if (!this.isProtectionEnabled(configService)) {
      throw deny(
        WebhookUrlErrorCode.NOT_ALLOWLISTED,
        'Outbound webhooks are disabled by WEBHOOK_SSRF_PROTECTION_ENABLED',
      );
    }

    if (typeof url !== 'string' || url.length === 0) {
      throw deny(
        WebhookUrlErrorCode.INVALID_URL,
        'url must be a non-empty string',
      );
    }
    if (url.length > MAX_WEBHOOK_URL_LENGTH) {
      throw deny(
        WebhookUrlErrorCode.INVALID_URL,
        `url must be at most ${MAX_WEBHOOK_URL_LENGTH} characters`,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw deny(
        WebhookUrlErrorCode.INVALID_URL,
        'url must be an absolute http(s) URL',
      );
    }

    if (parsed.protocol !== 'https:') {
      throw deny(WebhookUrlErrorCode.SCHEME_NOT_ALLOWED, 'url must use https');
    }

    // Credentials in the URL are a phishing/redirection trick and would leak
    // into logs and metrics via the URL string.
    if (parsed.username || parsed.password) {
      throw deny(
        WebhookUrlErrorCode.INVALID_URL,
        'url must not embed credentials',
      );
    }

    const host = normalizeHost(parsed.hostname);
    if (!host) {
      throw deny(WebhookUrlErrorCode.INVALID_URL, 'url must include a host');
    }

    if (isIpLiteral(host) && (isBlockedIpv4(host) || isBlockedIpv6(host))) {
      throw deny(
        WebhookUrlErrorCode.BLOCKED_HOST,
        'url host is a blocked private/internal address',
      );
    }

    const port = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
    if (!WEBHOOK_ALLOWED_PORTS.has(port) || this.blockedPorts.has(port)) {
      throw deny(
        WebhookUrlErrorCode.PORT_NOT_ALLOWED,
        `url port ${port} is not permitted`,
      );
    }

    if (!this.allowedHosts.has(host)) {
      throw deny(
        WebhookUrlErrorCode.NOT_ALLOWLISTED,
        'url host is not on the webhook allowlist',
      );
    }

    return {
      host,
      port,
      // Path only: a query string may carry a token, and this value is logged.
      redactedPath: `${parsed.pathname || '/'}`,
    };
  }
}

/** Builds an Error carrying a stable, machine-readable `code`. */
function deny(code: WebhookUrlErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: WebhookUrlErrorCode };
  err.code = code;
  return err;
}

function readEnv(
  configService: ConfigService | undefined,
  key: string,
): string | undefined {
  const fromConfig = configService?.get<string>(key);
  if (fromConfig !== undefined && fromConfig !== null && fromConfig !== '') {
    return fromConfig;
  }
  const fromEnv = process.env[key];
  return fromEnv === '' ? undefined : fromEnv;
}

function parseHostList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => normalizeHost(entry.trim()))
      .filter((entry): entry is string => entry !== null),
  );
}

function parsePortList(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

/** Lowercases and strips a trailing dot so `Example.com.` === `example.com`. */
function normalizeHost(host: string | undefined): string | null {
  if (!host) {
    return null;
  }
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  return trimmed.length > 0 ? trimmed : null;
}
