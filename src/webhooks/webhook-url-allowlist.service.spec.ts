import { ConfigService } from '@nestjs/config';
import {
  MAX_WEBHOOK_URL_LENGTH,
  WebhookUrlAllowlistService,
  WebhookUrlErrorCode,
  WEBHOOK_ALLOWED_HOSTS_ENV,
  WEBHOOK_BLOCKED_PORTS_ENV,
  WEBHOOK_SSRF_PROTECTION_ENABLED_ENV,
} from './webhook-url-allowlist.service';

/** Builds a service over an explicit env map, so tests never touch real env. */
function serviceWith(env: Record<string, string>): WebhookUrlAllowlistService {
  const config = new ConfigService(env);
  return new WebhookUrlAllowlistService(config);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('WebhookUrlAllowlistService (SSRF allowlist)', () => {
  const ENV_KEYS = [
    WEBHOOK_ALLOWED_HOSTS_ENV,
    WEBHOOK_BLOCKED_PORTS_ENV,
    WEBHOOK_SSRF_PROTECTION_ENABLED_ENV,
  ];

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  describe('allowlist is deny-by-default', () => {
    it('rejects every URL when no allowlist is configured', () => {
      const service = serviceWith({});

      expect(
        codeOf(() => service.assertAllowed('https://example.com/webhook')),
      ).toBe(WebhookUrlErrorCode.NOT_ALLOWLISTED);
    });

    it('rejects a well-formed https URL whose host is not allowlisted', () => {
      const service = serviceWith({
        [WEBHOOK_ALLOWED_HOSTS_ENV]: 'hooks.example.com',
      });

      expect(
        codeOf(() => service.assertAllowed('https://evil.example.org/webhook')),
      ).toBe(WebhookUrlErrorCode.NOT_ALLOWLISTED);
    });

    it('accepts an allowlisted host and normalizes the decision', () => {
      const service = serviceWith({
        [WEBHOOK_ALLOWED_HOSTS_ENV]: 'hooks.example.com',
      });

      const decision = service.assertAllowed(
        'https://hooks.example.com/webhook?token=shhh',
      );

      expect(decision.host).toBe('hooks.example.com');
      expect(decision.port).toBe(443);
      // The query string may hold a token, so it is never echoed back.
      expect(decision.redactedPath).toBe('/webhook');
    });

    it('is case-insensitive and tolerates a trailing root dot', () => {
      const service = serviceWith({
        [WEBHOOK_ALLOWED_HOSTS_ENV]: 'Hooks.Example.com',
      });

      expect(service.assertAllowed('https://HOOKS.example.com./x').host).toBe(
        'hooks.example.com',
      );
    });
  });

  describe('transport hardening', () => {
    const service = () =>
      serviceWith({ [WEBHOOK_ALLOWED_HOSTS_ENV]: 'example.com' });

    it('refuses plaintext http', () => {
      expect(
        codeOf(() => service().assertAllowed('http://example.com/hook')),
      ).toBe(WebhookUrlErrorCode.SCHEME_NOT_ALLOWED);
    });

    it('refuses non-http(s) schemes such as file: and gopher:', () => {
      expect(codeOf(() => service().assertAllowed('file:///etc/passwd'))).toBe(
        WebhookUrlErrorCode.SCHEME_NOT_ALLOWED,
      );
      expect(
        codeOf(() => service().assertAllowed('gopher://example.com/')),
      ).toBe(WebhookUrlErrorCode.SCHEME_NOT_ALLOWED);
    });

    it('refuses a non-standard port', () => {
      expect(
        codeOf(() => service().assertAllowed('https://example.com:8080/h')),
      ).toBe(WebhookUrlErrorCode.PORT_NOT_ALLOWED);
    });

    it('refuses an operator-blocked port even when globally allowed', () => {
      const restricted = serviceWith({
        [WEBHOOK_ALLOWED_HOSTS_ENV]: 'example.com',
        [WEBHOOK_BLOCKED_PORTS_ENV]: '8443',
      });

      expect(
        codeOf(() => restricted.assertAllowed('https://example.com:8443/h')),
      ).toBe(WebhookUrlErrorCode.PORT_NOT_ALLOWED);
    });

    it('refuses a URL embedding credentials', () => {
      expect(
        codeOf(() => service().assertAllowed('https://u:p@example.com/h')),
      ).toBe(WebhookUrlErrorCode.INVALID_URL);
    });
  });

  describe('internal targets are unreachable', () => {
    it.each([
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
    ])('refuses the internal IPv4 literal %s even when allowlisted', (ip) => {
      const withIp = serviceWith({ [WEBHOOK_ALLOWED_HOSTS_ENV]: ip });

      expect(codeOf(() => withIp.assertAllowed(`https://${ip}/hook`))).toBe(
        WebhookUrlErrorCode.BLOCKED_HOST,
      );
    });

    it.each(['[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[::ffff:127.0.0.1]'])(
      'refuses the internal IPv6 literal %s even when allowlisted',
      (ip) => {
        const withIp = serviceWith({ [WEBHOOK_ALLOWED_HOSTS_ENV]: ip });

        expect(codeOf(() => withIp.assertAllowed(`https://${ip}/hook`))).toBe(
          WebhookUrlErrorCode.BLOCKED_HOST,
        );
      },
    );

    it('does not over-block the public 172.32.0.0/12 boundary', () => {
      const public172 = serviceWith({
        [WEBHOOK_ALLOWED_HOSTS_ENV]: '172.32.0.1',
      });

      expect(
        codeOf(() => public172.assertAllowed('https://172.32.0.1/hook')),
      ).not.toBe(WebhookUrlErrorCode.BLOCKED_HOST);
    });
  });

  describe('adversarial input', () => {
    const service = () =>
      serviceWith({ [WEBHOOK_ALLOWED_HOSTS_ENV]: 'example.com' });

    it('refuses a non-string url', () => {
      expect(codeOf(() => service().assertAllowed(undefined))).toBe(
        WebhookUrlErrorCode.INVALID_URL,
      );
      expect(
        codeOf(() => service().assertAllowed({ toString: () => 'x' })),
      ).toBe(WebhookUrlErrorCode.INVALID_URL);
    });

    it('refuses an unparseable url', () => {
      expect(codeOf(() => service().assertAllowed('not-a-url'))).toBe(
        WebhookUrlErrorCode.INVALID_URL,
      );
    });

    it('refuses an oversized url before doing any further work', () => {
      const long = `https://example.com/${'a'.repeat(MAX_WEBHOOK_URL_LENGTH)}`;

      expect(codeOf(() => service().assertAllowed(long))).toBe(
        WebhookUrlErrorCode.INVALID_URL,
      );
    });
  });

  describe('kill-switch', () => {
    it('is enabled when unset (fail-closed default)', () => {
      expect(serviceWith({}).isProtectionEnabled()).toBe(true);
    });

    it('refuses all URLs when explicitly disabled — no allow-all bypass', () => {
      const off = serviceWith({
        [WEBHOOK_ALLOWED_HOSTS_ENV]: 'example.com',
        [WEBHOOK_SSRF_PROTECTION_ENABLED_ENV]: 'false',
      });

      expect(off.isProtectionEnabled()).toBe(false);
      expect(codeOf(() => off.assertAllowed('https://example.com/hook'))).toBe(
        WebhookUrlErrorCode.NOT_ALLOWLISTED,
      );
    });

    it('honours a redundant explicit "true"', () => {
      const on = serviceWith({
        [WEBHOOK_SSRF_PROTECTION_ENABLED_ENV]: 'true',
      });

      expect(on.isProtectionEnabled()).toBe(true);
    });
  });

  it('describes the allowlist without leaking anything secret', () => {
    const service = serviceWith({
      [WEBHOOK_ALLOWED_HOSTS_ENV]: 'b.example.com, a.example.com',
    });

    expect(service.describeAllowlist()).toEqual({
      allowedHosts: ['a.example.com', 'b.example.com'],
      allowedPorts: [443, 8443],
    });
  });
});
