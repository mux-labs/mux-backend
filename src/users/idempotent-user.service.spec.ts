import { Prisma } from '../generated/prisma/client';
import { IdempotentUserService } from './idempotent-user.service';

describe('IdempotentUserService.createUserWithRaceHandling', () => {
  const createdUser = { id: 'user-1', address: 'GABC' };
  const existingUser = { id: 'user-2', address: 'GABC' };

  let prisma: {
    user: {
      create: jest.Mock;
      findUnique: jest.Mock;
    };
  };
  let service: IdempotentUserService;

  beforeEach(() => {
    prisma = {
      user: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    service = new IdempotentUserService(prisma as any);
  });

  it('returns the created user on a successful create', async () => {
    prisma.user.create.mockResolvedValue(createdUser);

    const result = await service.createUserWithRaceHandling({ address: 'GABC' } as any);

    expect(result).toBe(createdUser);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('recovers from a P2002 unique constraint violation by returning the existing user', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.user.create.mockRejectedValue(p2002);
    prisma.user.findUnique.mockResolvedValue(existingUser);

    const result = await service.createUserWithRaceHandling({ address: 'GABC' } as any);

    expect(result).toBe(existingUser);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-throws non-P2002 errors', async () => {
    const otherError = new Prisma.PrismaClientKnownRequestError('Foreign key failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    prisma.user.create.mockRejectedValue(otherError);

    await expect(
      service.createUserWithRaceHandling({ address: 'GABC' } as any),
    ).rejects.toBe(otherError);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
