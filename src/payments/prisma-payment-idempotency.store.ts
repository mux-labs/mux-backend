import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PaymentExecutionResult,
  PaymentIdempotencyReservation,
  PaymentIdempotencyStore,
  StoredPaymentResult,
} from './payment-money-path.model';

/**
 * How long an idempotency record survives. Matches the operational contract in
 * `docs/IDEMPOTENCY-TTL.md`: `expiresAt` is the only expiry rule, and the
 * cleanup worker prunes rows past it.
 */
export const PAYMENT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Discriminates payment records from every other idempotency consumer. */
const ENDPOINT = 'POST /v1/payments';
const METHOD = 'POST';

/** Shape stored in `IdempotencyRecord.response`. */
interface ReservationPayload {
  state: 'RESERVED' | 'COMPLETE';
  fingerprint: string;
  result?: PaymentExecutionResult;
}

/** The narrow slice of an `IdempotencyRecord` row this adapter consumes. */
interface IdempotencyRecordRow {
  id: string;
  key: string;
  response: unknown;
  expiresAt: Date;
}

/** Structural view of the `IdempotencyRecord` delegate this adapter uses. */
interface IdempotencyRecordDelegate {
  findUnique(args: {
    where: { key: string };
  }): Promise<IdempotencyRecordRow | null>;
  create(args: {
    data: {
      key: string;
      method: string;
      endpoint: string;
      response: ReservationPayload;
      statusCode: number;
      expiresAt: Date;
    };
  }): Promise<{ id: string }>;
  updateMany(args: {
    where: { id: string };
    data: { response: ReservationPayload; statusCode: number };
  }): Promise<{ count: number }>;
  deleteMany(args: {
    where: { id?: string; key?: string; expiresAt?: { lt: Date } };
  }): Promise<{ count: number }>;
}

/**
 * Narrow structural view of the Prisma client, mirroring
 * `IdempotencyRecordStore` in `src/idempotency`: the adapter depends on the
 * exact queries it issues, not on generated client types, so a client
 * regeneration cannot change the contract.
 */
interface PrismaIdempotencyShape {
  idempotencyRecord: IdempotencyRecordDelegate;
}

/**
 * PaymentIdempotencyStore backed by the `IdempotencyRecord` table.
 *
 * Invariants:
 *  - **Principal-scoped keys.** The stored key is `sha256(subjectId \\n key)`,
 *    so one principal's key can neither replay nor overwrite another's, and the
 *    raw key/subject never appear in the table.
 *  - **Reserve before submit.** The row is created with `state: RESERVED`
 *    before the payment is submitted; a unique-key violation means another
 *    request got there first and is reported as `in_flight`, never as a miss.
 *  - **Fail-closed.** Any database failure propagates so the service can turn
 *    it into `DEPENDENCY_UNAVAILABLE`; there is no "no record found" fallback.
 *  - **TTL is the only expiry rule.** Expired rows are reclaimed on read;
 *    nothing else may delete a record whose TTL has not elapsed.
 */
@Injectable()
export class PrismaPaymentIdempotencyStore implements PaymentIdempotencyStore {
  private readonly logger = new Logger(PrismaPaymentIdempotencyStore.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Structural view of the client; see {@link PrismaIdempotencyShape}. */
  private get db(): PrismaIdempotencyShape {
    return this.prisma as unknown as PrismaIdempotencyShape;
  }

  async reserve(
    subjectId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<PaymentIdempotencyReservation> {
    const key = this.compositeKey(subjectId, idempotencyKey);
    const now = new Date();

    await this.db.idempotencyRecord.deleteMany({
      where: { key, expiresAt: { lt: now } },
    });

    const existing = await this.db.idempotencyRecord.findUnique({
      where: { key },
    });
    if (existing) {
      return this.interpret(existing, fingerprint);
    }

    try {
      const created = await this.db.idempotencyRecord.create({
        data: {
          key,
          method: METHOD,
          endpoint: ENDPOINT,
          response: { state: 'RESERVED', fingerprint },
          statusCode: 202,
          expiresAt: new Date(now.getTime() + PAYMENT_IDEMPOTENCY_TTL_MS),
        },
      });
      return { kind: 'reserved', reservationId: created.id };
    } catch (err) {
      // Unique-key violation: a concurrent request reserved first.
      if (!this.isUniqueViolation(err)) {
        throw err;
      }
      const raced = await this.db.idempotencyRecord.findUnique({
        where: { key },
      });
      if (!raced) {
        throw err;
      }
      return this.interpret(raced, fingerprint);
    }
  }

  async complete(
    reservationId: string,
    result: PaymentExecutionResult,
    fingerprint: string,
  ): Promise<void> {
    const updated = await this.db.idempotencyRecord.updateMany({
      where: { id: reservationId },
      data: {
        response: {
          state: 'COMPLETE',
          fingerprint,
          result,
        },
        statusCode: 200,
      },
    });
    if (updated.count !== 1) {
      // The reservation vanished (deleted externally): never report success
      // for a record we could not write — the service fails closed.
      throw new Error('idempotency reservation not found');
    }
  }

  async release(reservationId: string): Promise<void> {
    await this.db.idempotencyRecord.deleteMany({
      where: { id: reservationId },
    });
  }

  /** Classify an existing row against the incoming fingerprint. */
  private interpret(
    row: IdempotencyRecordRow,
    fingerprint: string,
  ): PaymentIdempotencyReservation {
    const payload = (row.response ?? {}) as ReservationPayload;
    if (payload.fingerprint !== fingerprint) {
      return { kind: 'mismatch' };
    }
    if (payload.state === 'COMPLETE' && payload.result) {
      const stored: StoredPaymentResult = {
        fingerprint,
        result: payload.result,
      };
      return { kind: 'replay', stored };
    }
    return { kind: 'in_flight' };
  }

  /** Principal-scoped, non-reversible key material for the store. */
  private compositeKey(subjectId: string, idempotencyKey: string): string {
    return createHash('sha256')
      .update(`${subjectId}\n${idempotencyKey}`)
      .digest('hex');
  }

  /** Prisma unique-constraint violation (P2002). */
  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'P2002'
    );
  }
}
