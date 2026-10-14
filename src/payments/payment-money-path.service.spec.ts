import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ErrorCode } from '../common/dto/error-envelope.dto';
import { MetricsService } from '../common/metrics/metrics.service';
import { PaymentMoneyPathService } from './payment-money-path.service';
import {
  PaymentIntent,
  PaymentNetwork,
  PaymentStatus,
  PaymentIdempotencyStore,
} from './payment-money-path.model';
import type {
  PaymentActor,
  PaymentExecutionResult,
} from './payment-money-path.model';
import {
  PAYMENT_DRY_RUN_ENABLED_ENV,
  PAYMENT_KILL_SWITCH_ENV,
  PAYMENT_MAINNET_ENABLED_ENV,
} from './payment-money-path.policy';

const CORRELATION_ID = 'corr-1';

/** Every env var a money-path test may touch; cleared around each test. */
const ENV_KEYS = [
  PAYMENT_DRY_RUN_ENABLED_ENV,
  PAYMENT_MAINNET_ENABLED_ENV,
  PAYMENT_KILL_SWITCH_ENV,
  'MAINNET_PAYMENT_ENABLED',
  'MAINNET_PAYMENTS_ENABLED',
  'FEATURE_MAINNET_PAYMENTS',
  'STELLAR_NETWORK',
  'SOROBAN_NETWORK',
  'STELLAR_HORIZON_MAINNET_URL',
  'NODE_ENV',
];

const owner: PaymentActor = {
  subjectId: 'user-1',
  role: 'owner',
  correlationId: CORRELATION_ID,
};

function liveIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    walletId: 'wal_sender',
    receiverWalletId: 'wal_receiver',
    amount: '25.5',
    assetCode: 'XLM',
    network: PaymentNetwork.TESTNET,
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

/** Stable error code carried by a Nest HTTP exception response body. */
function codeOf(err: unknown): string {
  const response =
    typeof (err as { getResponse?: unknown }).getResponse === 'function'
      ? (err as { getResponse: () => unknown }).getResponse()
      : undefined;
  return (response as { code?: string } | undefined)?.code ?? 'NO_CODE';
}

function statusOf(err: unknown): number {
  const exception = err as { getStatus?: () => number };
  return typeof exception.getStatus === 'function' ? exception.getStatus() : 0;
}

/** One reservation row held by the fake store. */
interface FakeRow {
  fingerprint: string;
  state: 'RESERVED' | 'COMPLETE';
  result?: PaymentExecutionResult;
}

interface FakeStore extends PaymentIdempotencyStore {
  rows: Map<string, FakeRow>;
  failOnReserve?: boolean;
}

/**
 * In-memory store implementing the reserve -> complete/release protocol.
 * Synchronous inside `reserve`, which is what lets the concurrency test model
 * two requests racing for the same key without a real database.
 */
function createFakeStore(): FakeStore {
  const rows = new Map<string, FakeRow>();
  const store: FakeStore = {
    rows,
    reserve(subjectId, idempotencyKey, fingerprint) {
      if (store.failOnReserve) {
        return Promise.reject(new Error('store down'));
      }
      const key = `${subjectId}::${idempotencyKey}`;
      const row = rows.get(key);
      if (row) {
        if (row.fingerprint !== fingerprint) {
          return Promise.resolve({ kind: 'mismatch' });
        }
        if (row.state === 'COMPLETE' && row.result) {
          return Promise.resolve({
            kind: 'replay',
            stored: { fingerprint: row.fingerprint, result: row.result },
          });
        }
        return Promise.resolve({ kind: 'in_flight' });
      }
      rows.set(key, { fingerprint, state: 'RESERVED' });
      return Promise.resolve({ kind: 'reserved', reservationId: key });
    },
    complete(reservationId, result, fingerprint) {
      const row = rows.get(reservationId);
      if (!row) {
        return Promise.reject(new Error('reservation gone'));
      }
      rows.set(reservationId, { fingerprint, state: 'COMPLETE', result });
      return Promise.resolve();
    },
    release(reservationId) {
      rows.delete(reservationId);
      return Promise.resolve();
    },
  };
  return store;
}

describe('PaymentMoneyPathService', () => {
  let service: PaymentMoneyPathService;
  let submission: { submit: jest.Mock };
  let store: FakeStore;
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    ENV_KEYS.forEach((key) => delete process.env[key]);
    process.env[PAYMENT_DRY_RUN_ENABLED_ENV] = 'true';
    process.env[PAYMENT_MAINNET_ENABLED_ENV] = 'true';
    process.env.STELLAR_HORIZON_MAINNET_URL = 'https://horizon.stellar.org';

    submission = {
      submit: jest.fn().mockResolvedValue({ transactionHash: 'tx-abc123' }),
    };
    store = createFakeStore();
    metrics = { incrementCounter: jest.fn() };

    service = new PaymentMoneyPathService(
      submission,
      store,
      metrics as unknown as MetricsService,
    );
  });

  afterEach(() => {
    ENV_KEYS.forEach((key) => delete process.env[key]);
    jest.restoreAllMocks();
  });

  // ── #945: dry-run never submits to Horizon ───────────────────────────────
  describe('dry-run (#945)', () => {
    it('never calls the submission port, even with the mainnet flag on', async () => {
      process.env[PAYMENT_MAINNET_ENABLED_ENV] = 'true';

      const result = await service.execute(
        liveIntent({ network: PaymentNetwork.MAINNET, dryRun: true }),
        owner,
      );

      expect(submission.submit).not.toHaveBeenCalled();
      expect(result.status).toBe(PaymentStatus.DRY_RUN);
      expect(result.dryRun).toBe(true);
      expect(result.transactionHash).toBeUndefined();
      expect(result.checks?.submission).toBe('SKIPPED');
    });

    it('never calls the submission port when the mainnet flag is off', async () => {
      process.env[PAYMENT_MAINNET_ENABLED_ENV] = 'false';

      const result = await service.execute(
        liveIntent({ network: PaymentNetwork.MAINNET, dryRun: true }),
        owner,
      );

      expect(result.status).toBe(PaymentStatus.DRY_RUN);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('is deny-by-default when PAYMENT_DRY_RUN_ENABLED is unset', async () => {
      delete process.env[PAYMENT_DRY_RUN_ENABLED_ENV];

      const err = await service
        .execute(liveIntent({ dryRun: true }), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(codeOf(err)).toBe(ErrorCode.PAYMENT_DRY_RUN_DISABLED);
      expect(statusOf(err)).toBe(403);
      expect(submission.submit).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(0);
    });

    it('requires an idempotency key before touching any dependency', async () => {
      const err = await service
        .execute(liveIntent({ dryRun: true, idempotencyKey: undefined }), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
      expect(store.rows.size).toBe(0);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('returns a preview with no key material or signed transaction', async () => {
      const result = await service.execute(liveIntent({ dryRun: true }), owner);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(
        /privateKey|encryptedSecret|signedTransaction/,
      );
      // Stellar secret seed shape.
      expect(serialized).not.toMatch(/\bS[A-Z2-7]{55}\b/);
      expect(result.preview).toBeDefined();
    });

    it('replays the identical dry-run under the same key', async () => {
      const intent = liveIntent({ dryRun: true });
      const first = await service.execute(intent, owner);
      const second = await service.execute(intent, owner);

      expect(second.replayed).toBe(true);
      expect(second.paymentId).toBe(first.paymentId);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('rejects the same key with a different payload', async () => {
      await service.execute(liveIntent({ dryRun: true }), owner);

      const err = await service
        .execute(liveIntent({ dryRun: true, amount: '99.99' }), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(codeOf(err)).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
      expect(statusOf(err)).toBe(409);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('fails closed when the idempotency store is unavailable', async () => {
      store.failOnReserve = true;

      const err = await service
        .execute(liveIntent({ dryRun: true }), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(codeOf(err)).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(statusOf(err)).toBe(503);
      expect(submission.submit).not.toHaveBeenCalled();
    });
  });

  // ── #946: mainnet flag off blocks value ──────────────────────────────────
  describe('mainnet feature flag (#946)', () => {
    it('blocks a live mainnet payment when the flag is off', async () => {
      process.env[PAYMENT_MAINNET_ENABLED_ENV] = 'false';

      const err = await service
        .execute(liveIntent({ network: PaymentNetwork.MAINNET }), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(codeOf(err)).toBe(ErrorCode.PAYMENT_MAINNET_DISABLED);
      expect(statusOf(err)).toBe(403);
      // Flag off blocks value: nothing signed, nothing persisted, no Horizon.
      expect(submission.submit).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(0);
    });

    it('blocks a live mainnet payment when the flag is unset (deny-by-default)', async () => {
      delete process.env[PAYMENT_MAINNET_ENABLED_ENV];

      const err = await service
        .execute(liveIntent({ network: PaymentNetwork.MAINNET }), owner)
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe(ErrorCode.PAYMENT_MAINNET_DISABLED);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('honours the documented legacy alias so a rename cannot flip the flag', async () => {
      process.env.MAINNET_PAYMENTS_ENABLED = 'true';

      const result = await service.execute(
        liveIntent({ network: PaymentNetwork.MAINNET }),
        owner,
      );

      expect(result.status).toBe(PaymentStatus.SUBMITTED);
      expect(submission.submit).toHaveBeenCalledTimes(1);
    });

    it('lets an explicit canonical `false` override a legacy `true`', async () => {
      process.env[PAYMENT_MAINNET_ENABLED_ENV] = 'false';
      process.env.MAINNET_PAYMENTS_ENABLED = 'true';

      const err = await service
        .execute(liveIntent({ network: PaymentNetwork.MAINNET }), owner)
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe(ErrorCode.PAYMENT_MAINNET_DISABLED);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('never gates testnet', async () => {
      process.env[PAYMENT_MAINNET_ENABLED_ENV] = 'false';

      const result = await service.execute(
        liveIntent({ network: PaymentNetwork.TESTNET }),
        owner,
      );

      expect(result.status).toBe(PaymentStatus.SUBMITTED);
      expect(submission.submit).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a production mainnet misconfiguration', async () => {
      process.env.NODE_ENV = 'production';
      process.env[PAYMENT_MAINNET_ENABLED_ENV] = 'true';
      delete process.env.STELLAR_HORIZON_MAINNET_URL;

      const err = await service
        .execute(liveIntent({ network: PaymentNetwork.MAINNET }), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(codeOf(err)).toBe(ErrorCode.PAYMENT_MAINNET_MISCONFIGURED);
      expect(statusOf(err)).toBe(503);
      expect(submission.submit).not.toHaveBeenCalled();
    });
  });

  describe('kill-switch', () => {
    it('stops live writes and dry-runs alike', async () => {
      process.env[PAYMENT_KILL_SWITCH_ENV] = 'true';

      const liveErr = await service
        .execute(liveIntent({ network: PaymentNetwork.TESTNET }), owner)
        .catch((e: unknown) => e);
      const dryErr = await service
        .execute(
          liveIntent({ network: PaymentNetwork.TESTNET, dryRun: true }),
          owner,
        )
        .catch((e: unknown) => e);

      expect(codeOf(liveErr)).toBe(ErrorCode.PAYMENT_KILL_SWITCH_ENGAGED);
      expect(codeOf(dryErr)).toBe(ErrorCode.PAYMENT_KILL_SWITCH_ENGAGED);
      expect(statusOf(liveErr)).toBe(403);
      expect(submission.submit).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(0);
    });
  });

  // ── exactly-once ────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('submits a live payment once and replays the original result', async () => {
      const intent = liveIntent();
      const first = await service.execute(intent, owner);
      const second = await service.execute(intent, owner);

      expect(submission.submit).toHaveBeenCalledTimes(1);
      expect(second.replayed).toBe(true);
      expect(second.paymentId).toBe(first.paymentId);
      expect(second.transactionHash).toBe(first.transactionHash);
    });

    it('scopes keys to the principal so another caller cannot replay them', async () => {
      const intent = liveIntent();
      await service.execute(intent, owner);

      const other: PaymentActor = {
        subjectId: 'user-2',
        role: 'owner',
        correlationId: 'corr-2',
      };
      const second = await service.execute(intent, other);

      // Two principals, two independent writes — no cross-principal replay.
      expect(submission.submit).toHaveBeenCalledTimes(2);
      expect(second.replayed).toBe(false);
      expect(second.correlationId).toBe('corr-2');
    });

    it('submits exactly once when two requests race for the same key', async () => {
      const intent = liveIntent();
      const settled = await Promise.allSettled([
        service.execute(intent, owner),
        service.execute(intent, owner),
      ]);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason: unknown = rejected[0].reason;
      expect(codeOf(reason)).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
      expect(submission.submit).toHaveBeenCalledTimes(1);
    });

    it('releases the key when submission fails, so the retry can proceed', async () => {
      submission.submit.mockRejectedValueOnce(new Error('horizon down'));

      const intent = liveIntent();
      const err = await service.execute(intent, owner).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(codeOf(err)).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(store.rows.size).toBe(0);

      // Same key again now succeeds: "503 safe to retry" is real.
      submission.submit.mockResolvedValueOnce({ transactionHash: 'tx-retry' });
      const retry = await service.execute(intent, owner);
      expect(retry.transactionHash).toBe('tx-retry');
      expect(submission.submit).toHaveBeenCalledTimes(2);
    });
  });

  // ── fail-closed ───────────────────────────────────────────────────────────
  describe('dependency outage', () => {
    it('rejects a live write when the submission port is down', async () => {
      submission.submit.mockRejectedValue(new Error('rpc unreachable'));

      const err = await service
        .execute(liveIntent(), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(codeOf(err)).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(statusOf(err)).toBe(503);
    });
  });

  // ── authz (deny-by-default) ──────────────────────────────────────────────
  describe('authorization', () => {
    it('rejects a request with no principal', async () => {
      const err = await service
        .execute(liveIntent(), { ...owner, subjectId: '' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(codeOf(err)).toBe(ErrorCode.UNAUTHENTICATED);
      expect(statusOf(err)).toBe(401);
      expect(submission.submit).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(0);
    });

    it('rejects a revoked delegate', async () => {
      const err = await service
        .execute(liveIntent(), {
          ...owner,
          role: 'delegate',
          delegateRevoked: true,
        })
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe(ErrorCode.DELEGATE_REVOKED);
      expect(statusOf(err)).toBe(403);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('rejects an unknown role', async () => {
      const err = await service
        .execute(liveIntent(), {
          ...owner,
          role: 'service' as PaymentActor['role'],
        })
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe(ErrorCode.INSUFFICIENT_ROLE);
      expect(statusOf(err)).toBe(403);
      expect(submission.submit).not.toHaveBeenCalled();
    });
  });

  // ── adversarial input ────────────────────────────────────────────────────
  describe('input validation', () => {
    it('rejects a self payment', async () => {
      const err = await service
        .execute(liveIntent({ receiverWalletId: 'wal_sender' }), owner)
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe(ErrorCode.VALIDATION_FAILED);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('rejects a non-positive or malformed amount', async () => {
      const err = await service
        .execute(liveIntent({ amount: '-1' }), owner)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(ErrorCode.VALIDATION_FAILED);
      expect(submission.submit).not.toHaveBeenCalled();
    });

    it('rejects an oversized intent before touching a dependency', async () => {
      const err = await service
        .execute(
          liveIntent({ idempotencyKey: `pad-${'x'.repeat(9000)}` }),
          owner,
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PayloadTooLargeException);
      expect(codeOf(err)).toBe(ErrorCode.VALIDATION_FAILED);
      expect(store.rows.size).toBe(0);
      expect(submission.submit).not.toHaveBeenCalled();
    });
  });
});
