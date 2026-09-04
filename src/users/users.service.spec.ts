import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaClient } from '../generated/prisma/client';
import { CreateUserDto } from './dto/create-user.dto';

/** Transaction-scoped client used by the mocked `$transaction`. */
const mockTx = {
  user: {
    update: jest.fn(),
  },
  wallet: {
    updateMany: jest.fn(),
  },
  developer: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  project: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  apiKey: {
    updateMany: jest.fn(),
  },
  webhookEndpoint: {
    updateMany: jest.fn(),
  },
};

const mockPrisma = {
  user: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  legacyUser: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn((cb: any) => cb(mockTx)),
};

describe('UsersService', () => {
  let service: UsersService;
  let prisma: typeof mockPrisma;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaClient,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    prisma = module.get<PrismaClient>(
      PrismaClient,
    ) as unknown as typeof mockPrisma;
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a new user', async () => {
    const dto: CreateUserDto = {
      authId: 'auth-123',
      email: 'test@example.com',
      displayName: 'Test User',
      authProvider: 'CUSTOM',
    };

    const mockUser = {
      id: 'user-123',
      authId: dto.authId,
      email: dto.email,
      displayName: dto.displayName,
      authProvider: dto.authProvider,
      status: 'ACTIVE',
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    prisma.user.create.mockResolvedValue(mockUser);

    const result = await service.create(dto);

    expect(result).toMatchObject({ id: 'user-123', authId: dto.authId });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        authId: dto.authId,
        email: dto.email,
        displayName: dto.displayName,
        authProvider: dto.authProvider,
        status: 'ACTIVE',
      },
    });
  });

  it('should throw ConflictException on duplicate authId', async () => {
    const dto: CreateUserDto = {
      authId: 'auth-123',
    };

    const error: any = new Error('Unique constraint failed');
    error.code = 'P2002';
    prisma.user.create.mockRejectedValue(error);

    await expect(service.create(dto)).rejects.toThrow(ConflictException);
  });

  it('should return all active users', async () => {
    const users = [{ id: 'user-123', deletedAt: null }];
    prisma.user.findMany.mockResolvedValue(users);

    await expect(service.findAll()).resolves.toEqual(users);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('should return paginated users when pagination options are provided', async () => {
    const users = [{ id: 'user-123', deletedAt: null }];
    prisma.user.findMany.mockResolvedValue(users);

    await expect(
      service.findAll({ page: 2, limit: 10, status: 'ACTIVE' as any }),
    ).resolves.toEqual(users);

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      skip: 10,
    });
  });

  it('should return a user by id', async () => {
    const user = {
      id: 'user-123',
      authId: 'auth-123',
      email: 'test@example.com',
      displayName: 'Test User',
      status: 'ACTIVE',
      authProvider: 'GOOGLE',
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    prisma.user.findUnique.mockResolvedValue(user);

    await expect(service.findOne('user-123')).resolves.toEqual({
      id: 'user-123',
      authId: 'auth-123',
      email: 'test@example.com',
      displayName: 'Test User',
      status: 'ACTIVE',
      authProvider: 'GOOGLE',
      lastLoginAt: null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-123' },
    });
  });

  it('should return legacy user when modern user is missing', async () => {
    const legacyUser = {
      id: 42,
      email: 'legacy@example.com',
      name: 'Legacy User',
    };

    prisma.user.findUnique.mockResolvedValue(null);
    prisma.legacyUser.findUnique.mockResolvedValue(legacyUser);

    await expect(service.findOne('42')).resolves.toEqual({
      id: '42',
      authId: 'legacy@example.com',
      email: 'legacy@example.com',
      displayName: 'Legacy User',
      status: 'ACTIVE',
      authProvider: 'LEGACY',
      lastLoginAt: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it('should throw NotFoundException when the user is missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.legacyUser.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing-id')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should update a user status using valid enum values', async () => {
    const updatedUser = {
      id: 'user-123',
      authId: 'auth-123',
      status: 'SUSPENDED',
      authProvider: 'CUSTOM',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.user.update.mockResolvedValue(updatedUser);

    const result = await service.update('user-123', {
      status: 'SUSPENDED' as any,
    });

    expect(result).toEqual(updatedUser);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-123' },
      data: { status: 'SUSPENDED' },
    });
  });

  it('should throw ConflictException when deleting an already deleted user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-123',
      deletedAt: new Date(),
      status: 'ACTIVE',
    });

    await expect(service.remove('user-123')).rejects.toThrow(ConflictException);
  });

  describe('remove() resource cleanup', () => {
    const activeUser = {
      id: 'user-123',
      deletedAt: null,
      status: 'ACTIVE',
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(activeUser);
      mockTx.wallet.updateMany.mockResolvedValue({ count: 0 });
      mockTx.developer.findMany.mockResolvedValue([]);
      mockTx.user.update.mockResolvedValue({
        ...activeUser,
        deletedAt: new Date(),
      });
    });

    it('disables the user\u2019s wallets and soft-deletes the user when nothing else is owned', async () => {
      mockTx.wallet.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.remove('user-123');

      expect(mockTx.wallet.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          status: { notIn: ['DISABLED', 'COMPROMISED', 'ARCHIVED'] },
        },
        data: {
          status: 'DISABLED',
          statusReason: 'Owner user deleted',
          statusChangedAt: expect.any(Date),
        },
      });
      expect(mockTx.developer.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123', deletedAt: null },
        select: { id: true },
      });
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result).toMatchObject({ id: 'user-123' });
    });

    it('revokes API keys, disables webhooks, and soft-deletes owned developers and projects', async () => {
      mockTx.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockTx.developer.findMany.mockResolvedValue([
        { id: 'dev-1' },
        { id: 'dev-2' },
      ]);
      mockTx.project.findMany.mockResolvedValue([
        { id: 'proj-1' },
        { id: 'proj-2' },
      ]);
      mockTx.apiKey.updateMany.mockResolvedValue({ count: 3 });
      mockTx.webhookEndpoint.updateMany.mockResolvedValue({ count: 1 });
      mockTx.project.updateMany.mockResolvedValue({ count: 2 });
      mockTx.developer.updateMany.mockResolvedValue({ count: 2 });

      await service.remove('user-123');

      expect(mockTx.developer.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123', deletedAt: null },
        select: { id: true },
      });
      expect(mockTx.project.findMany).toHaveBeenCalledWith({
        where: { developerId: { in: ['dev-1', 'dev-2'] }, deletedAt: null },
        select: { id: true },
      });
      expect(mockTx.apiKey.updateMany).toHaveBeenCalledWith({
        where: {
          projectId: { in: ['proj-1', 'proj-2'] },
          status: { not: 'REVOKED' },
        },
        data: {
          status: 'REVOKED',
          revokedAt: expect.any(Date),
          revokedReason: 'Owner user deleted',
        },
      });
      expect(mockTx.webhookEndpoint.updateMany).toHaveBeenCalledWith({
        where: {
          projectId: { in: ['proj-1', 'proj-2'] },
          status: { not: 'DISABLED' },
        },
        data: { status: 'DISABLED', deletedAt: expect.any(Date) },
      });
      expect(mockTx.project.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['proj-1', 'proj-2'] } },
        data: { deletedAt: expect.any(Date) },
      });
      expect(mockTx.developer.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['dev-1', 'dev-2'] } },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('only ever targets the deleted user\u2019s own developers', async () => {
      mockTx.developer.findMany.mockResolvedValue([{ id: 'dev-1' }]);
      mockTx.project.findMany.mockResolvedValue([{ id: 'proj-1' }]);
      mockTx.apiKey.updateMany.mockResolvedValue({ count: 1 });
      mockTx.webhookEndpoint.updateMany.mockResolvedValue({ count: 0 });
      mockTx.project.updateMany.mockResolvedValue({ count: 1 });
      mockTx.developer.updateMany.mockResolvedValue({ count: 1 });

      await service.remove('user-123');

      expect(mockTx.developer.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123', deletedAt: null },
        select: { id: true },
      });
      // The userId filter is the only thing that scopes the teardown.
      expect(mockTx.developer.findMany.mock.calls[0][0].where.userId).toBe(
        'user-123',
      );
    });

    it('soft-deletes owned developers even when they have no projects', async () => {
      mockTx.developer.findMany.mockResolvedValue([{ id: 'dev-1' }]);
      mockTx.project.findMany.mockResolvedValue([]);
      mockTx.developer.updateMany.mockResolvedValue({ count: 1 });

      await service.remove('user-123');

      expect(mockTx.project.updateMany).not.toHaveBeenCalled();
      expect(mockTx.apiKey.updateMany).not.toHaveBeenCalled();
      expect(mockTx.webhookEndpoint.updateMany).not.toHaveBeenCalled();
      expect(mockTx.developer.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['dev-1'] } },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('rolls back and propagates when the deletion transaction fails', async () => {
      (prisma.$transaction as jest.Mock).mockImplementationOnce(() =>
        Promise.reject(new Error('db connection lost')),
      );

      await expect(service.remove('user-123')).rejects.toThrow(
        'db connection lost',
      );
      expect(mockTx.wallet.updateMany).not.toHaveBeenCalled();
      expect(mockTx.user.update).not.toHaveBeenCalled();
    });
  });
});
