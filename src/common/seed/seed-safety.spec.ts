import {
  assertSeedAllowed,
  evaluateSeedPreflight,
  extractDatabaseHost,
  isLocalDatabaseHost,
  SEED_ALLOW_NON_LOCAL_ENV,
  SEED_BLOCK_CODES,
  SEED_INCLUDE_MAINNET_ENV,
  SeedNotAllowedError,
} from './seed-safety';

/**
 * Unit tests for the local-only seed gate (#928).
 *
 * The seed writes fake wallets/transactions with placeholder secrets, so it
 * must be impossible to run it against production, mainnet, or a shared
 * database by accident. These tests cover both the allow path and every
 * fail-closed refusal.
 */

const LOCAL_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  STELLAR_NETWORK: 'TESTNET',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mux',
};

describe('seed safety (#928)', () => {
  describe('extractDatabaseHost', () => {
    it('returns the host for a standard connection string', () => {
      expect(
        extractDatabaseHost('postgresql://user:pass@db.example.com:5432/mux'),
      ).toBe('db.example.com');
    });

    it('never returns credentials embedded in the connection string', () => {
      const host = extractDatabaseHost(
        'postgresql://superuser:sup3rs3cret@db.example.com:5432/mux',
      );
      expect(host).toBe('db.example.com');
      expect(host).not.toContain('sup3rs3cret');
    });

    it('handles the unencoded-credential strings Prisma tolerates', () => {
      expect(
        extractDatabaseHost('postgresql://user:p@ss word@localhost:5432/mux'),
      ).toBe('localhost');
    });

    it('handles an IPv6 literal host', () => {
      expect(extractDatabaseHost('postgresql://u:p@[::1]:5432/mux')).toBe(
        '[::1]',
      );
    });

    it('returns undefined for a missing URL', () => {
      expect(extractDatabaseHost(undefined)).toBeUndefined();
    });
  });

  describe('isLocalDatabaseHost', () => {
    it.each(['localhost', '127.0.0.1', '127.0.0.9', '0.0.0.0', '::1', 'db'])(
      'treats %s as local',
      (host) => {
        expect(isLocalDatabaseHost(host)).toBe(true);
      },
    );

    it.each(['db.example.com', 'prod-db.internal', '10.0.0.5', ''])(
      'treats %s as non-local',
      (host) => {
        expect(isLocalDatabaseHost(host)).toBe(false);
      },
    );
  });

  describe('evaluateSeedPreflight — fail-closed refusals', () => {
    it('blocks production regardless of any other setting', () => {
      const preflight = evaluateSeedPreflight({
        ...LOCAL_ENV,
        NODE_ENV: 'production',
        [SEED_ALLOW_NON_LOCAL_ENV]: 'true',
        [SEED_INCLUDE_MAINNET_ENV]: 'true',
      });

      expect(preflight.allowed).toBe(false);
      expect(preflight.code).toBe(SEED_BLOCK_CODES.PRODUCTION);
    });

    it.each(['PUBLIC', 'MAINNET', 'mainnet', ' public '])(
      'blocks the mainnet network value %s with no override available',
      (network) => {
        const preflight = evaluateSeedPreflight({
          ...LOCAL_ENV,
          STELLAR_NETWORK: network,
          [SEED_ALLOW_NON_LOCAL_ENV]: 'true',
          [SEED_INCLUDE_MAINNET_ENV]: 'true',
        });

        expect(preflight.allowed).toBe(false);
        expect(preflight.code).toBe(SEED_BLOCK_CODES.MAINNET);
      },
    );

    it('blocks a missing DATABASE_URL instead of assuming local', () => {
      const preflight = evaluateSeedPreflight({
        NODE_ENV: 'development',
        STELLAR_NETWORK: 'TESTNET',
      });

      expect(preflight.allowed).toBe(false);
      expect(preflight.code).toBe(SEED_BLOCK_CODES.DATABASE_URL);
    });

    it('blocks a non-local database without the explicit opt-in', () => {
      const preflight = evaluateSeedPreflight({
        ...LOCAL_ENV,
        DATABASE_URL: 'postgresql://user:pass@db.prod.example.com:5432/mux',
      });

      expect(preflight.allowed).toBe(false);
      expect(preflight.code).toBe(SEED_BLOCK_CODES.NON_LOCAL_DATABASE);
      expect(preflight.host).toBe('db.prod.example.com');
    });

    it('allows a non-local database once the operator opts in explicitly', () => {
      const preflight = evaluateSeedPreflight({
        ...LOCAL_ENV,
        DATABASE_URL: 'postgresql://user:pass@throwaway.example.com:5432/mux',
        [SEED_ALLOW_NON_LOCAL_ENV]: 'true',
      });

      expect(preflight.allowed).toBe(true);
    });

    it('rejects a malformed opt-in value instead of silently disabling it', () => {
      // A typo such as `treu` must be reported as its own stable code, never
      // read as either "denied" or "allowed". It is returned rather than thrown
      // so every refusal travels through the same `code` channel.
      const preflight = evaluateSeedPreflight({
        ...LOCAL_ENV,
        DATABASE_URL: 'postgresql://u:p@remote.example.com:5432/mux',
        [SEED_ALLOW_NON_LOCAL_ENV]: 'treu',
      });

      expect(preflight.allowed).toBe(false);
      expect(preflight.code).toBe(SEED_BLOCK_CODES.INVALID_FLAG);
    });

    it('rejects a malformed mainnet opt-in with the same code', () => {
      const preflight = evaluateSeedPreflight({
        ...LOCAL_ENV,
        [SEED_INCLUDE_MAINNET_ENV]: 'yes-please',
      });

      expect(preflight.allowed).toBe(false);
      expect(preflight.code).toBe(SEED_BLOCK_CODES.INVALID_FLAG);
    });

    it('does not let a flag typo mask a production block', () => {
      // The production refusal is the one an operator must always see, so it
      // is reported ahead of any flag parsing that could fail.
      const preflight = evaluateSeedPreflight({
        NODE_ENV: 'production',
        STELLAR_NETWORK: 'TESTNET',
        DATABASE_URL: 'postgresql://u:p@db.prod.example.com:5432/mux',
        [SEED_ALLOW_NON_LOCAL_ENV]: 'treu',
      });

      expect(preflight.allowed).toBe(false);
      expect(preflight.code).toBe(SEED_BLOCK_CODES.PRODUCTION);
    });

    it('does not let a flag typo mask a mainnet block', () => {
      const preflight = evaluateSeedPreflight({
        NODE_ENV: 'development',
        STELLAR_NETWORK: 'PUBLIC',
        DATABASE_URL: 'postgresql://u:p@db.prod.example.com:5432/mux',
        [SEED_INCLUDE_MAINNET_ENV]: 'maybe',
      });

      expect(preflight.allowed).toBe(false);
      expect(preflight.code).toBe(SEED_BLOCK_CODES.MAINNET);
    });
  });

  describe('evaluateSeedPreflight — mainnet wallet opt-in', () => {
    it('defaults to not creating mainnet demo wallets', () => {
      expect(evaluateSeedPreflight(LOCAL_ENV).includeMainnet).toBe(false);
    });

    it('creates them only when explicitly requested', () => {
      expect(
        evaluateSeedPreflight({
          ...LOCAL_ENV,
          [SEED_INCLUDE_MAINNET_ENV]: 'true',
        }).includeMainnet,
      ).toBe(true);
    });
  });

  describe('assertSeedAllowed', () => {
    it('returns the preflight on a safe local environment', () => {
      expect(() => assertSeedAllowed(LOCAL_ENV)).not.toThrow();
      expect(assertSeedAllowed(LOCAL_ENV).host).toBe('localhost');
    });

    it('throws a coded error in production', () => {
      expect(() =>
        assertSeedAllowed({ ...LOCAL_ENV, NODE_ENV: 'production' }),
      ).toThrow(SeedNotAllowedError);
      try {
        assertSeedAllowed({ ...LOCAL_ENV, NODE_ENV: 'production' });
      } catch (error) {
        expect((error as SeedNotAllowedError).code).toBe(
          SEED_BLOCK_CODES.PRODUCTION,
        );
      }
    });

    it('never leaks the database password in the error message', () => {
      let message = '';
      try {
        assertSeedAllowed({
          ...LOCAL_ENV,
          DATABASE_URL: 'postgresql://user:sup3rs3cret@db.example.com:5432/mux',
        });
      } catch (error) {
        message = (error as SeedNotAllowedError).message;
      }

      expect(message).toContain('db.example.com');
      expect(message).not.toContain('sup3rs3cret');
    });
  });
});
