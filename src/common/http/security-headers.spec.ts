import { RequestHandler } from 'express';
import {
  SECURITY_HEADERS,
  isHstsEnabled,
  securityHeaders,
} from './security-headers';

/** Minimal Response double capturing setHeader/removeHeader calls. */
function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    removeHeader(name: string) {
      delete headers[name];
    },
  };
}

/**
 * Express sets `X-Powered-By` by default, so the double seeds it the way
 * Express would — otherwise "the header is gone" proves nothing.
 */
function makeResWithPoweredBy() {
  const res = makeRes();
  res.setHeader('X-Powered-By', 'Express');
  return res;
}

function run(env: NodeJS.ProcessEnv = {}): Record<string, string> {
  const res = makeResWithPoweredBy();
  let called = false;

  securityHeaders(env)({} as never, res as never, () => {
    called = true;
  });

  if (!called) {
    throw new Error('middleware did not call next()');
  }

  return res.headers;
}

describe('securityHeaders (baseline security headers, #935)', () => {
  describe('baseline headers', () => {
    it('sets nosniff to block content-type confusion', () => {
      expect(run()['X-Content-Type-Options']).toBe('nosniff');
    });

    it('denies framing (clickjacking)', () => {
      expect(run()['X-Frame-Options']).toBe('DENY');
    });

    it('sets referrer policy to no-referrer so query-string ids do not leak', () => {
      expect(run()['Referrer-Policy']).toBe('no-referrer');
    });

    it('sets same-site resource policy so responses are not cross-site readable', () => {
      expect(run()['Cross-Origin-Resource-Policy']).toBe('same-site');
    });

    it('disables DNS prefetching', () => {
      expect(run()['X-DNS-Prefetch-Control']).toBe('off');
    });

    it('removes X-Powered-By rather than blanking it', () => {
      // An empty value still ships the header name on the wire; the header
      // has to be removed outright.
      expect(run()['X-Powered-By']).toBeUndefined();
    });

    it('sets a permissions policy that denies every unused capability', () => {
      const policy = run()['Permissions-Policy'];

      for (const feature of [
        'camera',
        'geolocation',
        'microphone',
        'payment',
        'usb',
      ]) {
        expect(policy).toContain(`${feature}=()`);
      }
    });

    it('applies the full documented baseline', () => {
      expect(run()).toEqual({ ...SECURITY_HEADERS });
    });

    it('calls next() so it never short-circuits the request', () => {
      const next = jest.fn();
      securityHeaders()({} as never, makeRes() as never, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('is idempotent on repeat calls', () => {
      const handler = securityHeaders();
      const res = makeResWithPoweredBy();

      handler({} as never, res as never, () => {});
      handler({} as never, res as never, () => {});

      expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(res.headers['X-Powered-By']).toBeUndefined();
    });

    it('does not set a CSP, which would be a no-op on a JSON API', () => {
      expect(run()['Content-Security-Policy']).toBeUndefined();
    });
  });

  describe('HSTS is opt-in', () => {
    it('omits Strict-Transport-Security by default', () => {
      // Unconditional HSTS would pin a developer's browser to HTTPS for
      // localhost and break local work.
      expect(run()['Strict-Transport-Security']).toBeUndefined();
    });

    it.each(['1', 'true', 'yes', 'on', 'TRUE', ' On '])(
      'enables HSTS when SECURITY_HEADERS_HSTS=%s',
      (value) => {
        expect(isHstsEnabled({ SECURITY_HEADERS_HSTS: value })).toBe(true);
        expect(
          run({ SECURITY_HEADERS_HSTS: value })['Strict-Transport-Security'],
        ).toBe('max-age=31536000; includeSubDomains');
      },
    );

    it.each(['0', 'false', 'no', 'off', '', 'maybe'])(
      'leaves HSTS off for SECURITY_HEADERS_HSTS=%s',
      (value) => {
        expect(isHstsEnabled({ SECURITY_HEADERS_HSTS: value })).toBe(false);
        expect(
          run({ SECURITY_HEADERS_HSTS: value })['Strict-Transport-Security'],
        ).toBeUndefined();
      },
    );

    it('leaves HSTS off when the variable is unset', () => {
      expect(isHstsEnabled({})).toBe(false);
    });
  });

  describe('deny-by-default guarantees', () => {
    it('never sets an allow-all permissions policy', () => {
      expect(run()['Permissions-Policy']).not.toMatch(/\*\s*$/);
      expect(run()['Permissions-Policy']).not.toContain('*');
    });

    it('never sets SAMEORIGIN frame options as a weaker default', () => {
      expect(run()['X-Frame-Options']).not.toBe('SAMEORIGIN');
    });

    it('does not mutate the shared SECURITY_HEADERS constant', () => {
      const snapshot = { ...SECURITY_HEADERS };
      run({ SECURITY_HEADERS_HSTS: 'true' });

      expect(SECURITY_HEADERS).toEqual(snapshot);
    });
  });
});

describe('securityHeaders middleware typing', () => {
  it('returns an express RequestHandler', () => {
    const handler: RequestHandler = securityHeaders();
    expect(typeof handler).toBe('function');
  });
});
