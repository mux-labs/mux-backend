import type { PrismaService } from '../prisma/prisma.service';
import type { PaymentExecutionResult } from './payment-money-path.model';
import {
  PAYMENT_IDEMPOTENCY_TTL_MS,
  PrismaPaymentIdempotencyStore,
} from './prisma-payment-idempotency.store';

/*
 * The fake Prisma delegate resolves synchronously while still returning the
 * promises the adapter awaits, so the fakes below are intentionally `async`
 * without `await` — they model a database round trip, not real I/O.
 */
/* eslint-disable @typescript-eslint/require-await */

const FINGERPRINT = 'fp-alpha';
const RESULT = {
  paymentId: 'pay_1',
  status: 'SUBMITTED',
  dryRun: false,
  network: 'TESTNET',
  walletId: 'wal_sender',
  receiverWalletId: 'wal_receiver',
  amount: '10',
  assetCode: 'XLM',
  transactionHash: 'tx-1',
  correlationId: 'corr-1',
  replayed: false,
} as PaymentExecutionResult;

describe('PrismaPaymentIdempotencyStore', () => {
  let rows: Map<
    string,
    { id: string; key: string; response: unknown; expiresAt: Date }
  >;
  let prisma: {
    idempotencyRecord: {
      deleteMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let store: PrismaPaymentIdempotencyStore;
  let seq: number;

  beforeEach(() => {
    seq = 0;
    rows = new Map();
    prisma = {
      idempotencyRecord: {
        deleteMany: jest.fn(
          async ({
            where,
          }: {
            where: { id?: string; key?: string; expiresAt?: { lt: Date } };
          }) => {
            let deleted = 0;
            for (const [key, row] of rows) {
              const matchesId = where.id !== undefined && row.id === where.id;
              const matchesKey =
                where.key !== undefined &&
                row.key === where.key &&
                where.expiresAt !== undefined &&
                row.expiresAt < where.expiresAt.lt;
              if (matchesId || matchesKey) {
                rows.delete(key);
                deleted += 1;
              }
            }
            return { count: deleted };
          },
        ),
        findUnique: jest.fn(
          async ({ where }: { where: { key: string } }) =>
            rows.get(where.key) ?? null,
        ),
        create: jest.fn(
          async (args: {
            data: { key: string; response: unknown; expiresAt: Date };
          }) => {
            if (rows.has(args.data.key)) {
              const error = new Error('unique constraint') as Error & {
                code: string;
              };
              error.code = 'P2002';
              throw error;
            }
            const id = `res-${++seq}`;
            rows.set(args.data.key, {
              id,
              key: args.data.key,
              response: args.data.response,
              expiresAt: args.data.expiresAt,
            });
            return { id };
          },
        ),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: { response: unknown };
          }) => {
            for (const row of rows.values()) {
              if (row.id === where.id) {
                row.response = data.response;
                return { count: 1 };
              }
            }
            return { count: 0 };
          },
        ),
      },
    };
    store = new PrismaPaymentIdempotencyStore(
      prisma as unknown as PrismaService,
    );
  });

  it('reserves a fresh key with a RESERVED row', async () => {
    const reservation = await store.reserve('user-1', 'key-1', FINGERPRINT);

    expect(reservation.kind).toBe('reserved');
    expect([...rows.values()][0].response).toMatchObject({
      state: 'RESERVED',
      fingerprint: FINGERPRINT,
    });
  });

  it('replays a completed record with the same fingerprint', async () => {
    const first = await store.reserve('user-1', 'key-1', FINGERPRINT);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await store.complete(first.reservationId, RESULT, FINGERPRINT);

    const second = await store.reserve('user-1', 'key-1', FINGERPRINT);

    expect(second.kind).toBe('replay');
    expect(second.kind === 'replay' && second.stored.result).toEqual(RESULT);
  });

  it('reports a mismatch when the same key carries a different payload', async () => {
    const first = await store.reserve('user-1', 'key-1', FINGERPRINT);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    await store.complete(first.reservationId, RESULT, FINGERPRINT);

    const second = await store.reserve('user-1', 'key-1', 'fp-beta');

    expect(second.kind).toBe('mismatch');
  });

  it('reports an in-flight duplicate instead of a miss', async () => {
    await store.reserve('user-1', 'key-1', FINGERPRINT);

    const second = await store.reserve('user-1', 'key-1', FINGERPRINT);

    expect(second.kind).toBe('in_flight');
  });

  it('scopes keys to the principal', async () => {
    await store.reserve('user-1', 'key-1', FINGERPRINT);
    const other = await store.reserve('user-2', 'key-1', FINGERPRINT);

    expect(other.kind).toBe('reserved');
    // Raw subject/key never appear in the stored key material.
    for (const row of rows.values()) {
      expect(row.key).not.toContain('user-1');
      expect(row.key).not.toContain('key-1');
      expect(row.key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('reclaims an expired reservation before reading (TTL is the only expiry)', async () => {
    const first = await store.reserve('user-1', 'key-1', FINGERPRINT);
    if (first.kind !== 'reserved') throw new Error('expected reservation');
    const row = [...rows.values()][0];
    row.expiresAt = new Date(Date.now() - 1);

    const second = await store.reserve('user-1', 'key-1', FINGERPRINT);

    expect(second.kind).toBe('reserved');
    const [expired] = prisma.idempotencyRecord.deleteMany.mock.calls[0] as [
      { where: { expiresAt: { lt: Date } } },
    ];
    expect(expired.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(PAYMENT_IDEMPOTENCY_TTL_MS).toBeGreaterThan(0);
  });

  it('propagates non-unique database failures instead of reporting a miss', async () => {
    prisma.idempotencyRecord.findUnique.mockRejectedValueOnce(
      new Error('connection refused'),
    );

    await expect(store.reserve('user-1', 'key-1', FINGERPRINT)).rejects.toThrow(
      'connection refused',
    );
  });

  it('fails closed when the reservation vanished before completion', async () => {
    await expect(
      store.complete('missing', RESULT, FINGERPRINT),
    ).rejects.toThrow('idempotency reservation not found');
  });

  it('releases a reservation so a retry may proceed', async () => {
    const first = await store.reserve('user-1', 'key-1', FINGERPRINT);
    if (first.kind !== 'reserved') throw new Error('expected reservation');

    await store.release(first.reservationId);

    expect(rows.size).toBe(0);
    const second = await store.reserve('user-1', 'key-1', FINGERPRINT);
    expect(second.kind).toBe('reserved');
  });
});
