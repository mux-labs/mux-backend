import {
  CORS_MAX_AGE_SECONDS,
  CORS_METHODS,
  buildCorsOptions,
  isOriginAllowed,
  normalizeOrigin,
  parseCorsAllowlist,
} from './cors';

const ALLOWLIST = ['https://app.mux.finance', 'https://partner.example.com'];

/** Invokes the configured origin callback and resolves to "was it allowed". */
function checkOrigin(
  allowlist: readonly string[],
  origin: string | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    const options = buildCorsOptions(allowlist);
    (
      options.origin as (
        o?: string,
        cb: (e: Error | null, a?: boolean) => void,
      ) => void
    )(origin, (err, allow) => resolve(err === null && allow === true));
  });
}

describe('CORS allowlist policy (#934)', () => {
  describe('normalizeOrigin', () => {
    it('lower-cases and strips trailing slashes so a browser origin matches', () => {
      // Browsers send the origin without a trailing slash; comparing raw
      // values would silently fail to match.
      expect(normalizeOrigin('https://App.Mux.Finance/')).toBe(
        'https://app.mux.finance',
      );
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeOrigin('  https://app.mux.finance  ')).toBe(
        'https://app.mux.finance',
      );
    });
  });

  describe('isOriginAllowed — exact match only', () => {
    it('allows an exactly-listed origin', () => {
      expect(isOriginAllowed('https://app.mux.finance', ALLOWLIST)).toBe(true);
    });

    it('allows a listed origin sent with a trailing slash', () => {
      expect(isOriginAllowed('https://app.mux.finance/', ALLOWLIST)).toBe(true);
    });

    it('allows a request with no Origin header (non-browser caller)', () => {
      // curl and server-to-server clients send no Origin; CORS is a
      // browser-enforced mechanism and must not become an auth layer.
      expect(isOriginAllowed(undefined, ALLOWLIST)).toBe(true);
    });

    it('rejects an unlisted origin', () => {
      expect(isOriginAllowed('https://evil.com', ALLOWLIST)).toBe(false);
    });

    it('rejects a subdomain of a listed origin', () => {
      // Suffix matching would admit this — that is the bug being prevented.
      expect(isOriginAllowed('https://evil.app.mux.finance', ALLOWLIST)).toBe(
        false,
      );
    });

    it('rejects a parent domain of a listed origin', () => {
      expect(isOriginAllowed('https://mux.finance', ALLOWLIST)).toBe(false);
    });

    it('rejects a listed host with a different scheme', () => {
      // http:// must not inherit https://'s allowlist entry.
      expect(isOriginAllowed('http://app.mux.finance', ALLOWLIST)).toBe(false);
    });

    it('rejects a listed host on a different port', () => {
      expect(isOriginAllowed('https://app.mux.finance:8443', ALLOWLIST)).toBe(
        false,
      );
    });

    it('rejects an origin that merely has a listed origin as a prefix', () => {
      expect(
        isOriginAllowed('https://app.mux.finance.evil.com', ALLOWLIST),
      ).toBe(false);
    });

    it('rejects a spoofed origin embedding a listed origin in the query', () => {
      // `includes`/`endsWith` matching would wrongly allow this.
      expect(
        isOriginAllowed('https://evil.com/?next=https://app.mux.finance', [
          ...ALLOWLIST,
        ]),
      ).toBe(false);
    });

    it('rejects a listed origin with injected credentials', () => {
      expect(
        isOriginAllowed('https://app.mux.finance@evil.com', ALLOWLIST),
      ).toBe(false);
    });

    it('rejects everything when the allowlist is empty', () => {
      expect(isOriginAllowed('https://app.mux.finance', [])).toBe(false);
    });
  });

  describe('parseCorsAllowlist — wildcards are rejected, not honoured', () => {
    it('keeps ordinary origins', () => {
      const { allowed, rejected } = parseCorsAllowlist(ALLOWLIST);

      expect(allowed).toEqual(ALLOWLIST);
      expect(rejected).toEqual([]);
    });

    it('drops a bare wildcard and reports it', () => {
      // `*` is invalid alongside credentials:true and would allow everything.
      const { allowed, rejected } = parseCorsAllowlist(['*']);

      expect(allowed).toEqual([]);
      expect(rejected).toEqual([
        {
          entry: '*',
          reason: 'wildcard origins are not allowed with credentials enabled',
        },
      ]);
    });

    it('drops a subdomain wildcard and reports it', () => {
      const { allowed, rejected } = parseCorsAllowlist([
        'https://*.mux.finance',
      ]);

      expect(allowed).toEqual([]);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].entry).toBe('https://*.mux.finance');
    });

    it('keeps the valid entries when a wildcard is mixed in', () => {
      const { allowed, rejected } = parseCorsAllowlist([
        'https://app.mux.finance',
        '*',
      ]);

      expect(allowed).toEqual(['https://app.mux.finance']);
      expect(rejected).toHaveLength(1);
    });

    it('drops empty and whitespace-only entries without reporting them', () => {
      const { allowed, rejected } = parseCorsAllowlist([
        'https://app.mux.finance',
        '',
        '   ',
      ]);

      expect(allowed).toEqual(['https://app.mux.finance']);
      expect(rejected).toEqual([]);
    });

    it('de-duplicates repeated entries', () => {
      const { allowed } = parseCorsAllowlist([
        'https://app.mux.finance',
        'https://app.mux.finance',
      ]);

      expect(allowed).toEqual(['https://app.mux.finance']);
    });
  });

  describe('buildCorsOptions', () => {
    it('allows an allowlisted origin', async () => {
      await expect(
        checkOrigin(ALLOWLIST, 'https://app.mux.finance'),
      ).resolves.toBe(true);
    });

    it('refuses a non-allowlisted origin with an error', async () => {
      // The browser then blocks the response; no ACAO header is emitted.
      await expect(checkOrigin(ALLOWLIST, 'https://evil.com')).resolves.toBe(
        false,
      );
    });

    it('refuses a subdomain of an allowlisted origin', async () => {
      await expect(
        checkOrigin(ALLOWLIST, 'https://evil.app.mux.finance'),
      ).resolves.toBe(false);
    });

    it('ignores a wildcard present in the configured allowlist', async () => {
      await expect(checkOrigin(['*'], 'https://evil.com')).resolves.toBe(false);
    });

    it('keeps credentials enabled only alongside a specific-origin policy', () => {
      // Safe because ACAO is always a literal allowlisted origin, never `*`.
      expect(buildCorsOptions(ALLOWLIST).credentials).toBe(true);
    });

    it('exposes exactly the documented methods and headers', () => {
      const options = buildCorsOptions(ALLOWLIST);

      expect(options.methods).toEqual([...CORS_METHODS]);
      expect(options.allowedHeaders).toEqual(
        expect.arrayContaining(['Content-Type', 'Authorization', 'X-API-Key']),
      );
      expect(options.exposedHeaders).toEqual(
        expect.arrayContaining(['X-Request-ID']),
      );
      expect(options.maxAge).toBe(CORS_MAX_AGE_SECONDS);
    });
  });
});
