import {
  assertNetworkMatch,
  extractRequestedNetwork,
  NetworkErrorCode,
  normalizeNetwork,
  networksMatch,
  ScopedNetwork,
} from './network-mismatch';

describe('network scoping (#943)', () => {
  describe('normalizeNetwork', () => {
    it('accepts TESTNET/MAINNET case-insensitively', () => {
      expect(normalizeNetwork('testnet')).toBe(ScopedNetwork.TESTNET);
      expect(normalizeNetwork(' MAINNET ')).toBe(ScopedNetwork.MAINNET);
    });

    it('returns null for anything else so callers can fail closed', () => {
      expect(normalizeNetwork('testnet-')).toBeNull();
      expect(normalizeNetwork('localnet')).toBeNull();
      expect(normalizeNetwork(undefined)).toBeNull();
      expect(normalizeNetwork(42)).toBeNull();
      expect(normalizeNetwork({ network: 'TESTNET' })).toBeNull();
    });
  });

  describe('networksMatch', () => {
    it('an unscoped credential matches every network', () => {
      expect(networksMatch(null, ScopedNetwork.TESTNET)).toBe(true);
      expect(networksMatch(undefined, ScopedNetwork.MAINNET)).toBe(true);
    });

    it('a scoped credential matches only its own network', () => {
      expect(networksMatch(ScopedNetwork.TESTNET, ScopedNetwork.TESTNET)).toBe(
        true,
      );
      expect(networksMatch(ScopedNetwork.TESTNET, ScopedNetwork.MAINNET)).toBe(
        false,
      );
      expect(networksMatch(ScopedNetwork.MAINNET, ScopedNetwork.TESTNET)).toBe(
        false,
      );
    });

    it('never matches an unparseable request network', () => {
      expect(networksMatch(ScopedNetwork.TESTNET, null)).toBe(false);
      expect(networksMatch(ScopedNetwork.TESTNET, 'localnet')).toBe(false);
    });
  });

  describe('assertNetworkMatch', () => {
    it('does nothing for an unscoped credential', () => {
      expect(() =>
        assertNetworkMatch({ scope: null, requested: 'MAINNET' }),
      ).not.toThrow();
    });

    it('throws NETWORK_MISMATCH when the target differs from the scope', () => {
      try {
        assertNetworkMatch({
          scope: ScopedNetwork.TESTNET,
          requested: 'MAINNET',
          correlationId: 'req-1',
          subject: 'api-key',
        });
        throw new Error('expected a mismatch');
      } catch (error) {
        const body = error.getResponse?.() ?? error;
        expect(error.status).toBe(403);
        expect(body.code).toBe(NetworkErrorCode.NETWORK_MISMATCH);
        expect(body.correlationId).toBe('req-1');
        // The message must name both networks but never any key material.
        expect(body.message).toContain('TESTNET');
        expect(body.message).toContain('MAINNET');
        expect(body.message).not.toMatch(/mux_(test|live)_/);
      }
    });

    it('throws INVALID_NETWORK (400) for an unrecognised network', () => {
      try {
        assertNetworkMatch({
          scope: ScopedNetwork.MAINNET,
          requested: 'localnet',
        });
        throw new Error('expected an invalid network');
      } catch (error) {
        expect(error.status).toBe(400);
        expect(error.getResponse().code).toBe(NetworkErrorCode.INVALID_NETWORK);
      }
    });
  });

  describe('extractRequestedNetwork', () => {
    it('prefers the explicit header', () => {
      expect(
        extractRequestedNetwork({
          headers: { 'x-mux-network': 'MAINNET' },
          body: { network: 'TESTNET' },
        }),
      ).toBe('MAINNET');
    });

    it('falls back to body, then params, then query', () => {
      expect(extractRequestedNetwork({ body: { network: 'TESTNET' } })).toBe(
        'TESTNET',
      );
      expect(extractRequestedNetwork({ params: { network: 'MAINNET' } })).toBe(
        'MAINNET',
      );
      expect(extractRequestedNetwork({ query: { network: 'TESTNET' } })).toBe(
        'TESTNET',
      );
    });

    it('returns undefined when the request does not name a network', () => {
      expect(extractRequestedNetwork({ body: {} })).toBeUndefined();
      expect(extractRequestedNetwork({ body: { network: 7 } })).toBeUndefined();
      expect(extractRequestedNetwork({})).toBeUndefined();
    });
  });
});
