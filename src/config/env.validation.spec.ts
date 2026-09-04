/**
 * Unit tests for the startup environment validator.
 *
 * NODE_ENV=test is set by Jest, so validateEnv() throws an Error instead of
 * calling process.exit(). This lets us assert on the error message.
 */
import { validateEnv, ValidatedEnv } from './env.validation';

// ─── Minimal valid env ────────────────────────────────────────────────────────

const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_test',
  WALLET_ENCRYPTION_KEY: 'a'.repeat(32), // exactly 32 chars
  EXPORT_SIGNING_SECRET: 'b'.repeat(32),
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_NETWORK: 'TESTNET',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...VALID_ENV, ...overrides };
}

function expectError(input: NodeJS.ProcessEnv, fragment: string) {
  expect(() => validateEnv(input)).toThrow(fragment);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('validateEnv()', () => {
  describe('DATABASE_URL', () => {
    it('accepts a valid postgresql:// URL', () => {
      expect(() => validateEnv(env())).not.toThrow();
    });

    it('accepts a postgres:// URL', () => {
      expect(() =>
        validateEnv(env({ DATABASE_URL: 'postgres://u:p@localhost/db' })),
      ).not.toThrow();
    });

    it('rejects when absent', () => {
      expectError(env({ DATABASE_URL: undefined }), 'DATABASE_URL is required');
    });

    it('rejects empty string', () => {
      expectError(env({ DATABASE_URL: '' }), 'DATABASE_URL is required');
    });

    it('rejects non-postgres scheme', () => {
      expectError(
        env({ DATABASE_URL: 'mysql://user:pass@localhost/db' }),
        'DATABASE_URL must be a PostgreSQL connection string',
      );
    });
  });

  describe('WALLET_ENCRYPTION_KEY', () => {
    it('accepts a key of exactly 32 characters', () => {
      expect(() =>
        validateEnv(env({ WALLET_ENCRYPTION_KEY: 'x'.repeat(32) })),
      ).not.toThrow();
    });

    it('accepts a key longer than 32 characters', () => {
      expect(() =>
        validateEnv(env({ WALLET_ENCRYPTION_KEY: 'x'.repeat(64) })),
      ).not.toThrow();
    });

    it('rejects when absent', () => {
      expectError(
        env({ WALLET_ENCRYPTION_KEY: undefined }),
        'WALLET_ENCRYPTION_KEY is required',
      );
    });

    it('rejects a key shorter than 32 characters', () => {
      expectError(
        env({ WALLET_ENCRYPTION_KEY: 'short' }),
        'WALLET_ENCRYPTION_KEY must be at least 32 characters',
      );
    });
  });

  describe('EXPORT_SIGNING_SECRET', () => {
    it('requires a value in production', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        expect(() =>
          validateEnv(env({ EXPORT_SIGNING_SECRET: undefined })),
        ).toThrow('EXPORT_SIGNING_SECRET is required in production');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('allows a missing value outside production', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      try {
        expect(() => validateEnv(env({ EXPORT_SIGNING_SECRET: undefined }))).not.toThrow();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });

  describe('STELLAR_HORIZON_URL', () => {
    it('accepts a valid https URL', () => {
      expect(() => validateEnv(env())).not.toThrow();
    });

    it('accepts a valid http URL', () => {
      expect(() =>
        validateEnv(env({ STELLAR_HORIZON_URL: 'http://localhost:8000' })),
      ).not.toThrow();
    });

    it('rejects when absent', () => {
      expectError(
        env({ STELLAR_HORIZON_URL: undefined }),
        'STELLAR_HORIZON_URL is required',
      );
    });

    it('rejects a non-URL string', () => {
      expectError(
        env({ STELLAR_HORIZON_URL: 'not-a-url' }),
        'STELLAR_HORIZON_URL must be a valid URL',
      );
    });

    it('rejects ftp:// scheme', () => {
      expectError(
        env({ STELLAR_HORIZON_URL: 'ftp://example.com' }),
        'STELLAR_HORIZON_URL must use http or https protocol',
      );
    });
  });

  describe('STELLAR_NETWORK', () => {
    it('accepts TESTNET', () => {
      expect(() =>
        validateEnv(env({ STELLAR_NETWORK: 'TESTNET' })),
      ).not.toThrow();
    });

    it('accepts MAINNET when paired with a mainnet Horizon URL', () => {
      expect(() =>
        validateEnv(
          env({
            STELLAR_NETWORK: 'MAINNET',
            STELLAR_HORIZON_URL: 'https://horizon.stellar.org',
          }),
        ),
      ).not.toThrow();
    });

    it('rejects when absent', () => {
      expectError(
        env({ STELLAR_NETWORK: undefined }),
        'STELLAR_NETWORK is required',
      );
    });

    it('rejects an unknown value', () => {
      expectError(
        env({ STELLAR_NETWORK: 'DEVNET' }),
        'STELLAR_NETWORK must be one of: TESTNET, MAINNET',
      );
    });

    it('rejects MAINNET paired with a testnet Horizon URL', () => {
      expectError(
        env({
          STELLAR_NETWORK: 'MAINNET',
          STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        }),
        'STELLAR_HORIZON_URL appears to point to testnet but STELLAR_NETWORK=MAINNET',
      );
    });

    it('rejects TESTNET paired with a mainnet Horizon URL', () => {
      expectError(
        env({
          STELLAR_NETWORK: 'TESTNET',
          STELLAR_HORIZON_URL: 'https://horizon.mainnet.stellar.org',
        }),
        'STELLAR_HORIZON_URL appears to point to mainnet but STELLAR_NETWORK=TESTNET',
      );
    });
  });

  describe('BALANCE_SYNC_INTERVAL_MS', () => {
    it('defaults to 10 minutes', () => {
      expect(validateEnv(env()).BALANCE_SYNC_INTERVAL_MS).toBe(600_000);
    });

    it('accepts a custom value', () => {
      expect(
        validateEnv(env({ BALANCE_SYNC_INTERVAL_MS: '120000' }))
          .BALANCE_SYNC_INTERVAL_MS,
      ).toBe(120_000);
    });

    it('rejects values below 1000ms', () => {
      expectError(
        env({ BALANCE_SYNC_INTERVAL_MS: '500' }),
        'BALANCE_SYNC_INTERVAL_MS must be >= 1000',
      );
    });
  });

  describe('BALANCE_SYNC_MAX_RETRIES', () => {
    it('defaults to 3', () => {
      expect(validateEnv(env()).BALANCE_SYNC_MAX_RETRIES).toBe(3);
    });

    it('rejects a negative value', () => {
      expectError(
        env({ BALANCE_SYNC_MAX_RETRIES: '-1' }),
        'BALANCE_SYNC_MAX_RETRIES must be >= 0',
      );
    });

    it('rejects values above 20', () => {
      expectError(
        env({ BALANCE_SYNC_MAX_RETRIES: '21' }),
        'BALANCE_SYNC_MAX_RETRIES must be <= 20',
      );
    });
  });

  describe('CORS_ORIGINS', () => {
    it('defaults to localhost:3000', () => {
      expect(validateEnv(env()).CORS_ORIGINS).toEqual([
        'http://localhost:3000',
      ]);
    });

    it('accepts a comma-separated list of valid origins', () => {
      expect(
        validateEnv(
          env({
            CORS_ORIGINS:
              'https://app.mux.finance, https://partner.example.com',
          }),
        ).CORS_ORIGINS,
      ).toEqual(['https://app.mux.finance', 'https://partner.example.com']);
    });

    it('rejects an invalid origin', () => {
      expectError(
        env({ CORS_ORIGINS: 'not-a-url' }),
        'CORS_ORIGINS entry "not-a-url" must be a valid URL',
      );
    });
  });

  describe('PORT', () => {
    it('defaults to 3000 when not set', () => {
      const result = validateEnv(env());
      expect(result.PORT).toBe(3000);
      expect(result.JSON_BODY_LIMIT_BYTES).toBe(102_400);
      expect(result.MAINTENANCE_ADMIN_SECRET).toBe('');
    });

    it('accepts a valid port number', () => {
      const result = validateEnv(env({ PORT: '8080' }));
      expect(result.PORT).toBe(8080);
    });

    it('rejects port 0', () => {
      expectError(env({ PORT: '0' }), 'PORT must be >= 1');
    });

    it('rejects port > 65535', () => {
      expectError(env({ PORT: '65536' }), 'PORT must be <= 65535');
    });

    it('rejects a non-integer string', () => {
      expectError(env({ PORT: 'abc' }), 'PORT must be an integer');
    });
  });

  describe('JSON_BODY_LIMIT_BYTES', () => {
    it('defaults to 100 KiB', () => {
      expect(validateEnv(env()).JSON_BODY_LIMIT_BYTES).toBe(102_400);
    });

    it('accepts a custom byte limit', () => {
      expect(
        validateEnv(env({ JSON_BODY_LIMIT_BYTES: '1048576' }))
          .JSON_BODY_LIMIT_BYTES,
      ).toBe(1_048_576);
    });

    it('rejects values above 10 MiB', () => {
      expectError(
        env({ JSON_BODY_LIMIT_BYTES: '10485761' }),
        'JSON_BODY_LIMIT_BYTES must be <= 10485760',
      );
    });
  });

  describe('AUTH_RATE_LIMIT_MAX', () => {
    it('defaults to 10', () => {
      const result = validateEnv(env());
      expect(result.AUTH_RATE_LIMIT_MAX).toBe(10);
    });

    it('accepts a custom value', () => {
      const result = validateEnv(env({ AUTH_RATE_LIMIT_MAX: '20' }));
      expect(result.AUTH_RATE_LIMIT_MAX).toBe(20);
    });

    it('rejects 0', () => {
      expectError(
        env({ AUTH_RATE_LIMIT_MAX: '0' }),
        'AUTH_RATE_LIMIT_MAX must be >= 1',
      );
    });
  });

  describe('AUTH_RATE_LIMIT_WINDOW_MS', () => {
    it('defaults to 60000', () => {
      const result = validateEnv(env());
      expect(result.AUTH_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    });

    it('rejects a value below 1000ms', () => {
      expectError(
        env({ AUTH_RATE_LIMIT_WINDOW_MS: '500' }),
        'AUTH_RATE_LIMIT_WINDOW_MS must be >= 1000',
      );
    });
  });

  describe('WEBHOOK_MAX_RETRIES', () => {
    it('defaults to 5', () => {
      const result = validateEnv(env());
      expect(result.WEBHOOK_MAX_RETRIES).toBe(5);
    });

    it('accepts 0 (disable retries)', () => {
      const result = validateEnv(env({ WEBHOOK_MAX_RETRIES: '0' }));
      expect(result.WEBHOOK_MAX_RETRIES).toBe(0);
    });

    it('rejects a value above 100', () => {
      expectError(
        env({ WEBHOOK_MAX_RETRIES: '101' }),
        'WEBHOOK_MAX_RETRIES must be <= 100',
      );
    });
  });

  describe('WEBHOOK_TIMEOUT_MS', () => {
    it('defaults to 10000', () => {
      const result = validateEnv(env());
      expect(result.WEBHOOK_TIMEOUT_MS).toBe(10_000);
    });

    it('rejects values below 100ms', () => {
      expectError(
        env({ WEBHOOK_TIMEOUT_MS: '50' }),
        'WEBHOOK_TIMEOUT_MS must be >= 100',
      );
    });
  });

  describe('STELLAR_HORIZON_MAX_RETRIES', () => {
    it('defaults to 3', () => {
      expect(validateEnv(env()).STELLAR_HORIZON_MAX_RETRIES).toBe(3);
    });

    it('accepts a custom value', () => {
      expect(
        validateEnv(env({ STELLAR_HORIZON_MAX_RETRIES: '5' }))
          .STELLAR_HORIZON_MAX_RETRIES,
      ).toBe(5);
    });

    it('rejects a negative value', () => {
      expectError(
        env({ STELLAR_HORIZON_MAX_RETRIES: '-1' }),
        'STELLAR_HORIZON_MAX_RETRIES must be >= 0',
      );
    });

    it('rejects a value above 100', () => {
      expectError(
        env({ STELLAR_HORIZON_MAX_RETRIES: '101' }),
        'STELLAR_HORIZON_MAX_RETRIES must be <= 100',
      );
    });

    it('rejects a non-integer string', () => {
      expectError(
        env({ STELLAR_HORIZON_MAX_RETRIES: 'abc' }),
        'STELLAR_HORIZON_MAX_RETRIES must be an integer',
      );
    });
  });

  describe('MAINTENANCE_ADMIN_SECRET in production', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('fails closed when unset in production', () => {
      process.env.NODE_ENV = 'production';
      const exitSpy = jest
        .spyOn(process, 'exit')
        .mockImplementation(() => {
          throw new Error('process.exit called');
        });
      const stderrSpy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        expect(() =>
          validateEnv(env({ MAINTENANCE_ADMIN_SECRET: '' })),
        ).toThrow('process.exit called');
        expect(stderrSpy.mock.calls[0][0]).toContain(
          'MAINTENANCE_ADMIN_SECRET is required in production',
        );
      } finally {
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('passes when MAINTENANCE_ADMIN_SECRET is set in production', () => {
      process.env.NODE_ENV = 'production';
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        expect(() =>
          validateEnv(
            env({
              MAINTENANCE_ADMIN_SECRET: 'a-real-secret',
              AUTH_IDENTITY_PROVIDER: 'CLERK',
              CLERK_JWT_PUBLIC_KEY: 'key',
            }),
          ),
        ).not.toThrow();
      } finally {
        exitSpy.mockRestore();
      }
    });
  });

  describe('multiple violations', () => {
    it('reports all errors in a single throw', () => {
      const badEnv = env({
        DATABASE_URL: undefined,
        WALLET_ENCRYPTION_KEY: undefined,
        STELLAR_HORIZON_URL: undefined,
      });

      let message = '';
      try {
        validateEnv(badEnv);
      } catch (e: any) {
        message = e.message;
      }

      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('WALLET_ENCRYPTION_KEY');
      expect(message).toContain('STELLAR_HORIZON_URL');
      expect(message).toContain('3 environment variable problem(s)');
    });
  });

  describe('return value', () => {
    it('returns a fully-typed ValidatedEnv on success', () => {
      const result: ValidatedEnv = validateEnv(
        env({
          PORT: '4000',
          AUTH_RATE_LIMIT_MAX: '25',
          API_KEY_ROTATION_GRACE_SECONDS: '7200',
        }),
      );

      expect(result.PORT).toBe(4000);
      expect(result.AUTH_RATE_LIMIT_MAX).toBe(25);
      expect(result.API_KEY_ROTATION_GRACE_SECONDS).toBe(7200);
      expect(result.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
      expect(result.WALLET_ENCRYPTION_KEY).toBe(
        VALID_ENV.WALLET_ENCRYPTION_KEY,
      );
      expect(result.STELLAR_HORIZON_URL).toBe(VALID_ENV.STELLAR_HORIZON_URL);
    });

    it('fills in all defaults when only required fields are set', () => {
      const result = validateEnv(env());
      expect(result.PORT).toBe(3000);
      expect(result.BALANCE_STALE_THRESHOLD_MS).toBe(300_000);
      expect(result.WEBHOOK_MAX_RETRIES).toBe(5);
      expect(result.WEBHOOK_RETRY_BACKOFF_MS).toBe(1_000);
      expect(result.WEBHOOK_TIMEOUT_MS).toBe(10_000);
      expect(result.WEBHOOK_MAX_CONSECUTIVE_FAILURES).toBe(10);
      expect(result.AUTH_RATE_LIMIT_MAX).toBe(10);
      expect(result.AUTH_RATE_LIMIT_WINDOW_MS).toBe(60_000);
      expect(result.RATE_LIMIT_WINDOW_MS).toBe(60_000);
      expect(result.RATE_LIMIT_MAX_REQUESTS).toBe(100);
      expect(result.RATE_LIMIT_SENSITIVE_WINDOW_MS).toBe(60_000);
      expect(result.RATE_LIMIT_SENSITIVE_MAX_REQUESTS).toBe(10);
      expect(result.API_KEY_ROTATION_GRACE_SECONDS).toBe(3_600);
    });
  });
});
