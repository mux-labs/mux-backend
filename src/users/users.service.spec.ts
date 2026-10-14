import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { IdempotentUserService } from './idempotent-user.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService - remove (#968)', () => {
  let service: UsersService;
  let prisma: any;
  let metrics: jest.Mocked<MetricsService>;
  let idempotentUser: jest.Mocked<IdempotentUserService>;

  const mockUser = {
    id: 'user-123',
    authId: 'auth-test',
    email: 'test@example.com',
    displayName: 'Test User',
    status: 'ACTIVE',
    authProvider: 'GOOGLE',
    defaultNetwork: 'TESTNET',
    lastLoginAt: new Date('2026-09-01T00:00:00Z'),
    lastLoginIp: '192.168.1.1',
    lastLoginUserAgent: 'Mozilla/5.0',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    deletedAt: null,
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    metrics = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
    } as unknown as jest.Mocked<MetricsService>;

    idempotentUser = {
      findOrCreateUser: jest.fn(),
      findUserByAuthId: jest.fn(),
    } as unknown as jest.Mocked<IdempotentUserService>;

    service = new UsersService(
      idempotentUser,
      metrics,
      prisma as unknown as PrismaService,
    );
  });

  it('soft-deletes an active user and redacts sensitive PII fields', async () => {
    const deletedDate = new Date('2026-10-01T12:00:00Z');
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.user.update.mockResolvedValue({
      ...mockUser,
      status: 'DISABLED',
      deletedAt: deletedDate,
    });

    const result = await service.remove('user-123');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-123' },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: {
        status: 'DISABLED',
        deletedAt: expect.any(Date),
      },
    });
    expect(result.id).toBe('user-123');
    expect(result.status).toBe('DISABLED');
    expect(result.deletedAt).toEqual(deletedDate);
    expect(result).not.toHaveProperty('lastLoginIp');
    expect(result).not.toHaveProperty('lastLoginUserAgent');
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'user.deletion.success',
      1,
    );
  });

  it('is idempotent: returns already-deleted user without performing another update', async () => {
    const existingDeleted = {
      ...mockUser,
      status: 'DISABLED',
      deletedAt: new Date('2026-09-15T00:00:00Z'),
    };
    prisma.user.findUnique.mockResolvedValue(existingDeleted);

    const result = await service.remove('user-123');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-123' },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(result.id).toBe('user-123');
    expect(result.deletedAt).toEqual(existingDeleted.deletedAt);
  });

  it('throws NotFoundException when user does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.remove('unknown-user')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('fails closed when database throws', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('DB failure'));

    await expect(service.remove('user-123')).rejects.toThrow('DB failure');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
