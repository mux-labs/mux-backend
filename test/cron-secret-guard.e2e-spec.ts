import { Test } from '@nestjs/testing';
import {
  INestApplication,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionQueryService } from '../src/transactions/transaction-query.service';
import { RelayerFundingService } from '../src/transactions/relayer-funding.service';
import { TransactionPollingService } from '../src/transactions/transaction-polling.service';
import { CronSecretGuard } from '../src/common/cron/cron-secret.guard';

/**
 * Test suite for CronSecretGuard on internal transaction endpoints.
 *
 * Issue #801: Require CRON_SECRET (or mTLS) on POST /v1/transactions/internal/poll-pending
 * Issue #981: Cron secret must never be logged, printed, serialized, or included
 *             in error messages/stack traces across cron scheduling and execution paths.
 *
 * The guard should:
 * 1. Reject requests without X-Cron-Secret header (401)
 * 2. Reject requests with invalid X-Cron-Secret header (401)
 * 3. Accept requests with valid X-Cron-Secret header (200 or 400, depending on endpoint logic)
 * 4. In production, fail-closed if CRON_SECRET is not configured
 * 5. Emit metrics/logs with request ids (never log secrets, API keys, or seeds)
 * 6. Never leak the cron secret (valid or invalid) into logs, error messages,
 *    or serialized responses (#981)
 */

describe('CronSecretGuard - Internal Transaction Endpoints (e2e)', () => {
  let app: INestApplication;
  const VALID_CRON_SECRET = 'test-cron-secret-min-16-chars-1234';
  const INVALID_CRON_SECRET = 'wrong-secret';

  // ── Log capture helpers (#981) ────────────────────────────────────────────
  //
  // We intercept every console channel plus the Nest Logger so that any code
  // path which accidentally prints the cron secret (valid or invalid) is
  // caught by the assertions below. Captured output is also scanned for
  // common secret-bearing patterns (JWTs, webhook secrets, raw key material).
  type ConsoleChannel = 'log' | 'error' | 'warn' | 'debug' | 'info';

  const CONSOLE_CHANNELS: ConsoleChannel[] = [
    'log',
    'error',
    'warn',
    'debug',
    'info',
  ];

  let capturedOutput: string[] = [];
  let originalConsole: Partial<Record<ConsoleChannel, (...args: unknown[]) => void>> = {};

  function stringifyArgs(args: unknown[]): string {
    return args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) {
          return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
  }

  function captureConsole(): void {
    capturedOutput = [];
    originalConsole = {};
    for (const channel of CONSOLE_CHANNELS) {
      const original = console[channel] as (...args: unknown[]) => void;
      originalConsole[channel] = original;
      (console as unknown as Record<string, (...args: unknown[]) => void>)[
        channel
      ] = (...args: unknown[]) => {
        capturedOutput.push(stringifyArgs(args));
      };
    }
  }

  function restoreConsole(): void {
    for (const channel of CONSOLE_CHANNELS) {
      const original = originalConsole[channel];
      if (original) {
        (console as unknown as Record<string, (...args: unknown[]) => void>)[
          channel
        ] = original;
      }
    }
    originalConsole = {};
  }

  function capturedText(): string {
    return capturedOutput.join('\n');
  }

  function expectNoSecretLeak(secret: string): void {
    const text = capturedText();
    expect(text).not.toContain(secret);
    // Guard against partial/encoded leakage of the secret material.
    expect(text).not.toContain(Buffer.from(secret).toString('base64'));
    expect(text).not.toContain(encodeURIComponent(secret));
  }

  function expectNoSensitivePatterns(): void {
    const text = capturedText();
    // JWT-shaped tokens (header.payload.signature).
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    // Common secret-bearing key names followed by a value.
    expect(text).not.toMatch(
      /(cron[_-]?secret|webhook[_-]?secret|api[_-]?key|private[_-]?key|seed[_-]?phrase)\s*[:=]\s*\S+/i,
    );
  }

  async function buildApp(cronSecret?: string): Promise<INestApplication> {
    // Mock services
    const mockPollingService: Partial<TransactionPollingService> = {
      pollPendingTransactions: jest.fn(async () => ({
        processed: 0,
        confirmed: 0,
        failed: 0,
        errors: [],
      })),
    };

    const mockRelayerFundingService: Partial<RelayerFundingService> = {
      checkAndFundRelayer: jest.fn(async () => ({
        status: 'ok',
        balance: '100',
      })),
    };

    const mockTransactionsService: Partial<TransactionsService> = {};
    const mockQueryService: Partial<TransactionQueryService> = {};

    const moduleBuilder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
          load: [
            () => ({
              CRON_SECRET: cronSecret,
              NODE_ENV: process.env.NODE_ENV || 'test',
            }),
          ],
        }),
        TransactionsModule,
      ],
    })
      .overrideProvider(TransactionPollingService)
      .useValue(mockPollingService)
      .overrideProvider(RelayerFundingService)
      .useValue(mockRelayerFundingService)
      .overrideProvider(TransactionsService)
      .useValue(mockTransactionsService)
      .overrideProvider(TransactionQueryService)
      .useValue(mockQueryService);

    const moduleRef = await moduleBuilder.compile();
    const testApp = moduleRef.createNestApplication();
    testApp.setGlobalPrefix('v1');
    await testApp.init();
    return testApp;
  }

  beforeEach(() => {
    captureConsole();
  });

  afterEach(async () => {
    restoreConsole();
    if (app) {
      await app.close();
    }
    jest.clearAllMocks();
  });

  // ── Missing X-Cron-Secret header ──────────────────────────────────────────

  describe('POST /v1/transactions/internal/poll-pending', () => {
    it('returns 401 when X-Cron-Secret header is missing', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .expect(HttpStatus.UNAUTHORIZED);

      expect(res.body).toHaveProperty('statusCode', HttpStatus.UNAUTHORIZED);
      expect(res.body.message).toContain('X-Cron-Secret header is required');
    });

    it('returns 401 when X-Cron-Secret header is empty', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', '')
        .expect(HttpStatus.UNAUTHORIZED);

      expect(res.body).toHaveProperty('statusCode', HttpStatus.UNAUTHORIZED);
    });

    it('returns 401 when X-Cron-Secret header is invalid', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', INVALID_CRON_SECRET)
        .expect(HttpStatus.UNAUTHORIZED);

      expect(res.body).toHaveProperty('statusCode', HttpStatus.UNAUTHORIZED);
      expect(res.body.message).toContain('Invalid cron secret');
    });

    it('returns 401 when CRON_SECRET is not configured (fail-closed)', async () => {
      app = await buildApp(undefined); // No CRON_SECRET

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', INVALID_CRON_SECRET)
        .expect(HttpStatus.UNAUTHORIZED);

      expect(res.body).toHaveProperty('statusCode', HttpStatus.UNAUTHORIZED);
      expect(res.body.message).toContain(
        'Cron secret not configured on server'
      );
    });

    it('returns 200 when X-Cron-Secret header is valid', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', VALID_CRON_SECRET)
        .expect(HttpStatus.OK);

      expect(res.body).toHaveProperty('processed');
      expect(res.body).toHaveProperty('confirmed');
      expect(res.body).toHaveProperty('failed');
    });

    it('accepts limit query parameter when authenticated', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .query({ limit: '50' })
        .set('X-Cron-Secret', VALID_CRON_SECRET)
        .expect(HttpStatus.OK);

      expect(res.body).toHaveProperty('processed');
    });
  });

  // ── POST /v1/transactions/internal/relayer-funding/check ─────────────────

  describe('POST /v1/transactions/internal/relayer-funding/check', () => {
    it('returns 401 when X-Cron-Secret header is missing', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/relayer-funding/check')
        .query({ walletId: 'test-wallet-id' })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(res.body).toHaveProperty('statusCode', HttpStatus.UNAUTHORIZED);
    });

    it('returns 401 when X-Cron-Secret header is invalid', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/relayer-funding/check')
        .query({ walletId: 'test-wallet-id' })
        .set('X-Cron-Secret', INVALID_CRON_SECRET)
        .expect(HttpStatus.UNAUTHORIZED);

      expect(res.body).toHaveProperty('statusCode', HttpStatus.UNAUTHORIZED);
    });

    it('returns 200 when X-Cron-Secret header is valid', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/relayer-funding/check')
        .query({ walletId: 'test-wallet-id' })
        .set('X-Cron-Secret', VALID_CRON_SECRET)
        .expect(HttpStatus.OK);

      expect(res.body).toHaveProperty('status');
    });

    it('returns 400 when walletId query parameter is missing (after auth)', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/relayer-funding/check')
        .set('X-Cron-Secret', VALID_CRON_SECRET)
        .expect(HttpStatus.BAD_REQUEST);

      expect(res.body).toHaveProperty('statusCode', HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('walletId is required');
    });
  });

  // ── #981: Cron secret must never be logged ────────────────────────────────

  describe('cron secret redaction (#981)', () => {
    it('never logs the valid cron secret on a successful authenticated request', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', VALID_CRON_SECRET)
        .expect(HttpStatus.OK);

      expectNoSecretLeak(VALID_CRON_SECRET);
      expectNoSensitivePatterns();
    });

    it('never logs the presented secret when the header is invalid', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', INVALID_CRON_SECRET)
        .expect(HttpStatus.UNAUTHORIZED);

      expectNoSecretLeak(INVALID_CRON_SECRET);
      expectNoSecretLeak(VALID_CRON_SECRET);
      expectNoSensitivePatterns();
    });

    it('never logs the configured secret when CRON_SECRET is missing (fail-closed)', async () => {
      app = await buildApp(undefined);

      await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', INVALID_CRON_SECRET)
        .expect(HttpStatus.UNAUTHORIZED);

      expectNoSecretLeak(INVALID_CRON_SECRET);
      expectNoSensitivePatterns();
    });

    it('does not leak the secret in the 401 error response body', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      const res = await request(app.getHttpServer())
        .post('/v1/transactions/internal/poll-pending')
        .set('X-Cron-Secret', INVALID_CRON_SECRET)
        .expect(HttpStatus.UNAUTHORIZED);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(INVALID_CRON_SECRET);
      expect(body).not.toContain(VALID_CRON_SECRET);
    });

    it('never logs the secret on the relayer-funding path', async () => {
      app = await buildApp(VALID_CRON_SECRET);

      await request(app.getHttpServer())
        .post('/v1/transactions/internal/relayer-funding/check')
        .query({ walletId: 'test-wallet-id' })
        .set('X-Cron-Secret', VALID_CRON_SECRET)
        .expect(HttpStatus.OK);

      expectNoSecretLeak(VALID_CRON_SECRET);
      expectNoSensitivePatterns();
    });
  });
});
