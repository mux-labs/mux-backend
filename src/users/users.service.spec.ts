import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaClient } from '../generated/prisma/client';
import { CreateUserDto } from './dto/create-user.dto';

const mockPrisma = {
  user: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
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
    prisma = module.get<PrismaClient>(PrismaClient) as unknown as typeof mockPrisma;
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
    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { deletedAt: null } });
  });

  it('should return a user by id', async () => {
    const user = { id: 'user-123', deletedAt: null };
    prisma.user.findUnique.mockResolvedValue(user);

    await expect(service.findOne('user-123')).resolves.toEqual(user);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-123' } });
  });

  it('should throw NotFoundException when the user is missing', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing-id')).rejects.toThrow(NotFoundException);
  });
});
