import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';

import { IsoUtcTimestampInterceptor } from './iso-utc-timestamp.interceptor';

describe('IsoUtcTimestampInterceptor', () => {
  let interceptor: IsoUtcTimestampInterceptor;

  const createContext = (): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({}),
      }),
    }) as unknown as ExecutionContext;

  const createHandler = (body: unknown): CallHandler => ({
    handle: () => of(body),
  });

  beforeEach(() => {
    interceptor = new IsoUtcTimestampInterceptor();
  });

  it('serializes a top-level Date to an ISO UTC string', async () => {
    const date = new Date('2026-07-30T12:34:56.789Z');

    const result = await firstValueFrom(
      interceptor.intercept(createContext(), createHandler(date)),
    );

    expect(result).toBe('2026-07-30T12:34:56.789Z');
    expect(result).toBe(date.toISOString());
  });

  it('serializes nested object Date values recursively', async () => {
    const createdAt = new Date('2026-07-30T12:34:56.789Z');
    const updatedAt = new Date('2026-08-01T00:00:00.000Z');

    const result = await firstValueFrom(
      interceptor.intercept(
        createContext(),
        createHandler({
          id: 'abc',
          meta: {
            createdAt,
            nested: { updatedAt },
          },
        }),
      ),
    );

    expect(result).toEqual({
      id: 'abc',
      meta: {
        createdAt: '2026-07-30T12:34:56.789Z',
        nested: { updatedAt: '2026-08-01T00:00:00.000Z' },
      },
    });
    expect(result.meta.createdAt).toBe(createdAt.toISOString());
    expect(result.meta.nested.updatedAt).toBe(updatedAt.toISOString());
  });

  it('serializes Date values inside arrays', async () => {
    const first = new Date('2026-07-30T12:34:56.789Z');
    const second = new Date('2026-07-31T01:02:03.004Z');

    const result = await firstValueFrom(
      interceptor.intercept(
        createContext(),
        createHandler({ timestamps: [first, second] }),
      ),
    );

    expect(result).toEqual({
      timestamps: [
        '2026-07-30T12:34:56.789Z',
        '2026-07-31T01:02:03.004Z',
      ],
    });
    expect(result.timestamps[0]).toBe(first.toISOString());
    expect(result.timestamps[1]).toBe(second.toISOString());
  });

  it('passes non-Date values through unchanged', async () => {
    const body = {
      id: 'abc',
      count: 42,
      active: true,
      missing: null,
      tags: ['a', 'b'],
    };

    const result = await firstValueFrom(
      interceptor.intercept(createContext(), createHandler(body)),
    );

    expect(result).toEqual(body);
  });
});
