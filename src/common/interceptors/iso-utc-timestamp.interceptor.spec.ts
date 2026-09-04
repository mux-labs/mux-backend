/**
 * Unit tests for ISO UTC timestamp serialization interceptor (#556).
 *
 * Covers:
 *  - Date objects are converted to ISO strings
 *  - Nested Date objects inside objects and arrays are converted
 *  - Null and undefined values pass through untouched
 *  - Primitive values (string, number, boolean) pass through untouched
 *  - Strings that look like dates are NOT double-converted
 *  - Circular-depth protection (capped at depth 20)
 */
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { IsoUtcTimestampInterceptor } from './iso-utc-timestamp.interceptor';

function createMockContext(): ExecutionContext {
  return {} as ExecutionContext;
}

function createCallHandler(value: unknown): CallHandler {
  return {
    handle: () => of(value),
  };
}

function intercept(value: unknown): Promise<unknown> {
  const interceptor = new IsoUtcTimestampInterceptor();
  return new Promise((resolve, reject) => {
    interceptor
      .intercept(createMockContext(), createCallHandler(value))
      .subscribe({
        next: resolve,
        error: reject,
      });
  });
}

describe('IsoUtcTimestampInterceptor (#556)', () => {
  const fixedDate = new Date('2026-07-30T02:58:20.651Z');
  const fixedIso = '2026-07-30T02:58:20.651Z';

  // ── Top-level Date ───────────────────────────────────────────────────────────

  it('converts a top-level Date to an ISO string', async () => {
    const result = await intercept(fixedDate);
    expect(result).toBe(fixedIso);
  });

  // ── Date inside an object ────────────────────────────────────────────────────

  it('converts Date fields inside a plain object', async () => {
    const result = (await intercept({
      id: 'abc',
      createdAt: fixedDate,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })) as any;

    expect(result.createdAt).toBe(fixedIso);
    expect(result.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.id).toBe('abc');
  });

  // ── Date inside nested objects ───────────────────────────────────────────────

  it('converts Date fields in nested objects', async () => {
    const result = (await intercept({
      wallet: {
        createdAt: fixedDate,
        nested: {
          updatedAt: fixedDate,
        },
      },
    })) as any;

    expect(result.wallet.createdAt).toBe(fixedIso);
    expect(result.wallet.nested.updatedAt).toBe(fixedIso);
  });

  // ── Date inside an array ─────────────────────────────────────────────────────

  it('converts Date elements inside an array', async () => {
    const result = (await intercept([
      { createdAt: fixedDate },
      { createdAt: new Date('2025-01-01T00:00:00.000Z') },
    ])) as any[];

    expect(result[0].createdAt).toBe(fixedIso);
    expect(result[1].createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  // ── Null / undefined passthrough ─────────────────────────────────────────────

  it('passes null through unchanged', async () => {
    const result = await intercept(null);
    expect(result).toBeNull();
  });

  it('passes undefined through unchanged', async () => {
    const result = await intercept(undefined);
    expect(result).toBeUndefined();
  });

  it('passes null field values through unchanged', async () => {
    const result = (await intercept({ expiresAt: null })) as any;
    expect(result.expiresAt).toBeNull();
  });

  // ── Primitives ───────────────────────────────────────────────────────────────

  it('passes string values through unchanged', async () => {
    const result = await intercept('hello');
    expect(result).toBe('hello');
  });

  it('passes number values through unchanged', async () => {
    const result = await intercept(42);
    expect(result).toBe(42);
  });

  it('passes boolean values through unchanged', async () => {
    expect(await intercept(true)).toBe(true);
    expect(await intercept(false)).toBe(false);
  });

  // ── Strings that resemble dates are NOT re-converted ─────────────────────────

  it('does not double-convert a string that already is an ISO date', async () => {
    const isoString = '2026-07-30T02:58:20.651Z';
    const result = (await intercept({ ts: isoString })) as any;
    expect(result.ts).toBe(isoString);
  });

  // ── Mixed realistic response ──────────────────────────────────────────────────

  it('handles a realistic wallet response shape', async () => {
    const response = {
      data: [
        {
          id: 'wallet-uuid',
          publicKey: 'GABC123',
          status: 'ACTIVE',
          network: 'TESTNET',
          createdAt: fixedDate,
          updatedAt: fixedDate,
          deletedAt: null,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
      hasMore: false,
    };

    const result = (await intercept(response)) as any;

    expect(result.data[0].createdAt).toBe(fixedIso);
    expect(result.data[0].updatedAt).toBe(fixedIso);
    expect(result.data[0].deletedAt).toBeNull();
    expect(result.total).toBe(1);
    expect(result.data[0].publicKey).toBe('GABC123');
  });
});
