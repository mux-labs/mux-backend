import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService.pass', () => {
  const buildService = (overrides: Record<string, unknown> = {}) => {
    const prisma = {
      idempotencyRecord: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        ...(overrides.prisma as Record<string, unknown>),
      },
    };
    const service = new IdempotencyService(prisma as never);
    return { service, prisma };
  };

  it('returns only counts and booleans, never keys or payloads', async () => {
    const { service } = buildService({
      prisma: {
        idempotencyRecord: {
          deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
        },
      },
    });

    const result = await service.pass();

    expect(result).toEqual(
      expect.objectContaining({
        deleted: expect.any(Number),
        ok: expect.any(Boolean),
      }),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/key/i);
    expect(serialized).not.toMatch(/body/i);
    expect(serialized).not.toMatch(/payload/i);
    expect(serialized).not.toMatch(/response/i);
  });

  it('reports the failure path as a boolean without leaking error details', async () => {
    const { service } = buildService({
      prisma: {
        idempotencyRecord: {
          deleteMany: jest
            .fn()
            .mockRejectedValue(new Error('boom secret-key payload')),
        },
      },
    });

    const result = await service.pass();

    expect(result.ok).toBe(false);
    expect(result.deleted).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/boom/);
    expect(JSON.stringify(result)).not.toMatch(/secret-key/);
  });
});
