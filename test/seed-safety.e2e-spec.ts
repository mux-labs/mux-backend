import * as fs from 'fs';
import * as path from 'path';
import {
  assertSeedAllowed,
  SEED_BLOCK_CODES,
  SeedNotAllowedError,
} from '../src/common/seed/seed-safety';

/**
 * Contract tests for the local-only seed gate (#928).
 *
 * These assert on the *source* of `prisma/seed.ts` rather than executing it:
 * running the seed would require a live database, and the point of the gate is
 * that it refuses before touching one. We assert the preflight runs before any
 * write, that the mainnet opt-in defaults to off, and that the failure output
 * cannot leak a database password.
 */

const SEED_PATH = path.join(__dirname, '..', 'prisma', 'seed.ts');
const seedSource = fs.readFileSync(SEED_PATH, 'utf8');

describe('prisma seed is local-only safe (#928)', () => {
  describe('source wiring', () => {
    it('calls the fail-closed preflight', () => {
      expect(seedSource).toContain('assertSeedAllowed');
    });

    it('runs the preflight before the first database write', () => {
      const preflightIndex = seedSource.indexOf('assertSeedAllowed()');
      const firstWriteIndex = seedSource.indexOf('prisma.user.upsert');

      expect(preflightIndex).toBeGreaterThan(-1);
      expect(firstWriteIndex).toBeGreaterThan(-1);
      // Deny-by-default: the gate must run before anything is persisted.
      expect(preflightIndex).toBeLessThan(firstWriteIndex);
    });

    it('gates the MAINNET wallet rows behind the opt-in flag', () => {
      expect(seedSource).toContain('preflight.includeMainnet');
    });

    it('reports a refusal with its stable code and exits non-zero', () => {
      expect(seedSource).toContain('SeedNotAllowedError');
      expect(seedSource).toContain('process.exit(1)');
    });
  });

  describe('preflight (evaluated directly)', () => {
    const localEnv = {
      NODE_ENV: 'development',
      STELLAR_NETWORK: 'TESTNET',
      DATABASE_URL: 'postgresql://user:hunter2@localhost:5432/mux',
    };

    it('allows a local testnet environment', () => {
      expect(() => {
        assertSeedAllowed(localEnv);
      }).not.toThrow();
    });

    it('refuses production with a stable code', () => {
      expect(() =>
        assertSeedAllowed({ ...localEnv, NODE_ENV: 'production' }),
      ).toThrow(SeedNotAllowedError);

      let code: string | undefined;
      try {
        assertSeedAllowed({ ...localEnv, NODE_ENV: 'production' });
      } catch (error) {
        code = (error as SeedNotAllowedError).code;
      }
      expect(code).toBe(SEED_BLOCK_CODES.PRODUCTION);
    });

    it('refuses a non-local database without the opt-in', () => {
      const remoteEnv = {
        ...localEnv,
        DATABASE_URL: 'postgresql://user:hunter2@db.prod.example.com:5432/mux',
      };

      expect(() => assertSeedAllowed(remoteEnv)).toThrow(SeedNotAllowedError);

      let code: string | undefined;
      try {
        assertSeedAllowed(remoteEnv);
      } catch (error) {
        code = (error as SeedNotAllowedError).code;
      }
      expect(code).toBe(SEED_BLOCK_CODES.NON_LOCAL_DATABASE);
    });

    it('never puts the database password in a refusal message', () => {
      let message = '';
      try {
        assertSeedAllowed({
          ...localEnv,
          DATABASE_URL:
            'postgresql://user:hunter2@db.prod.example.com:5432/mux',
        });
      } catch (error) {
        message = (error as SeedNotAllowedError).message;
      }

      expect(message).not.toContain('hunter2');
    });
  });

  describe('no secrets committed alongside the seed', () => {
    it('does not hard-code an encryption key in the seed', () => {
      // The seed's placeholder "encryptedSecret" is a label, not key material.
      expect(seedSource).not.toMatch(
        /WALLET_ENCRYPTION_KEY\s*=\s*['"][^'"]+['"]/,
      );
    });
  });
});
