import { CorsAllowlistController } from './cors-dashboard.controller';

function makeController(corsOrigins?: string) {
  const config = {
    get: jest.fn((key: string) =>
      key === 'CORS_ORIGINS' ? corsOrigins : undefined,
    ),
  };

  return {
    controller: new CorsAllowlistController(config as never),
    config,
  };
}

describe('CorsAllowlistController (#934)', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  describe('allowlist reporting', () => {
    it('reports the configured origins', () => {
      const { controller } = makeController(
        'https://app.mux.finance,https://partner.example.com',
      );

      expect(controller.getAllowlist().origins).toEqual([
        'https://app.mux.finance',
        'https://partner.example.com',
      ]);
    });

    it('reports a rejected wildcard with a reason instead of dropping it silently', () => {
      // An operator must be able to see that a configured entry was ignored —
      // otherwise "why is my origin blocked" has no answer.
      const { controller } = makeController('https://app.mux.finance,*');

      const report = controller.getAllowlist();

      expect(report.origins).toEqual(['https://app.mux.finance']);
      expect(report.rejected).toEqual([
        {
          entry: '*',
          reason: 'wildcard origins are not allowed with credentials enabled',
        },
      ]);
    });

    it('flags that the insecure localhost default is in effect when unset', () => {
      const { controller } = makeController(undefined);

      const report = controller.getAllowlist();

      expect(report.usingDefault).toBe(true);
      expect(report.origins).toEqual([]);
    });

    it('flags usingDefault=false once origins are configured', () => {
      const { controller } = makeController('https://app.mux.finance');

      expect(controller.getAllowlist().usingDefault).toBe(false);
    });

    it('ignores empty segments in the configured list', () => {
      const { controller } = makeController(
        'https://app.mux.finance, ,https://partner.example.com',
      );

      expect(controller.getAllowlist().origins).toEqual([
        'https://app.mux.finance',
        'https://partner.example.com',
      ]);
    });
  });

  describe('reported policy', () => {
    it('reports credentials enabled (paired with exact-origin matching)', () => {
      expect(
        makeController('https://app.mux.finance').controller.getAllowlist()
          .credentials,
      ).toBe(true);
    });

    it('reports the allowed methods and exposed headers', () => {
      const report = makeController(
        'https://app.mux.finance',
      ).controller.getAllowlist();

      expect(report.methods).toContain('POST');
      expect(report.allowedHeaders).toContain('Authorization');
      expect(report.exposedHeaders).toContain('X-Request-ID');
      expect(report.maxAgeSeconds).toBeGreaterThan(0);
    });

    it('reflects the production flag', () => {
      process.env.NODE_ENV = 'production';
      expect(
        makeController('https://app.mux.finance').controller.getAllowlist()
          .production,
      ).toBe(true);

      process.env.NODE_ENV = 'test';
      expect(
        makeController('https://app.mux.finance').controller.getAllowlist()
          .production,
      ).toBe(false);
    });
  });

  describe('never leaks secrets', () => {
    it('does not reflect a non-origin config value back to the caller', () => {
      const report = makeController(
        'https://app.mux.finance,WALLET_ENCRYPTION_KEY',
      ).controller.getAllowlist();

      // A secret pasted into CORS_ORIGINS must be reported as rejected, not
      // echoed back through an API response.
      expect(report.origins).toEqual(['https://app.mux.finance']);
      expect(report.rejected).toEqual([
        { entry: 'WALLET_ENCRYPTION_KEY', reason: 'not an http(s) origin' },
      ]);
    });

    it('serializes to a payload with no credential or key material', () => {
      const report = makeController(
        'https://app.mux.finance',
      ).controller.getAllowlist();

      expect(JSON.stringify(report)).not.toMatch(
        /private[_-]?key|encryptedSecret|cookie|token|secret/i,
      );
    });
  });
});
