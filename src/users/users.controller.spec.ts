import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { IdempotentUserService } from './idempotent-user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Mock the generated Prisma client (not generated in test env)
jest.mock('../generated/prisma/client', () => ({ PrismaClient: jest.fn() }), {
  virtual: true,
});
jest.mock('../prisma/prisma.service', () => ({ PrismaService: jest.fn() }), {
  virtual: true,
});

const mockUsersService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

const mockIdempotentUserService = {
  findOrCreateUser: jest.fn(),
};

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockUsersService },
        { provide: IdempotentUserService, useValue: mockIdempotentUserService },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should create a user', async () => {
    const dto: CreateUserDto = {
      authId: 'auth-123',
      email: 'user@example.com',
      displayName: 'Test User',
    };

    mockUsersService.create.mockResolvedValue({ id: 'user-123', ...dto });

    await expect(controller.create(dto)).resolves.toMatchObject({
      id: 'user-123',
      authId: dto.authId,
    });
    expect(mockUsersService.create).toHaveBeenCalledWith(dto);
  });

  describe('findOrCreate', () => {
    it('should return existing user with isNewUser=false when user already exists', async () => {
      const request = { authId: 'auth-123', email: 'user@example.com' };
      const serviceResult = {
        user: { id: 'user-123', authId: 'auth-123' },
        isNewUser: false,
      };

      mockIdempotentUserService.findOrCreateUser.mockResolvedValue(
        serviceResult,
      );

      await expect(controller.findOrCreate(request)).resolves.toEqual(
        serviceResult,
      );
      expect(mockIdempotentUserService.findOrCreateUser).toHaveBeenCalledWith(
        request,
      );
    });

    it('should return new user with isNewUser=true when user does not exist', async () => {
      const request = { authId: 'new-auth', email: 'new@example.com' };
      const serviceResult = {
        user: { id: 'new-user-123', authId: 'new-auth' },
        isNewUser: true,
      };

      mockIdempotentUserService.findOrCreateUser.mockResolvedValue(
        serviceResult,
      );

      await expect(controller.findOrCreate(request)).resolves.toEqual(
        serviceResult,
      );
    });

    it('should propagate errors from IdempotentUserService', async () => {
      const request = { authId: 'auth-bad' };
      mockIdempotentUserService.findOrCreateUser.mockRejectedValue(
        new Error('User creation failed'),
      );

      await expect(controller.findOrCreate(request)).rejects.toThrow(
        'User creation failed',
      );
    });
  });

  it('should return paginated users', async () => {
    const users = [{ id: 'user-123' }];
    mockUsersService.findAll.mockResolvedValue(users);

    await expect(controller.findAll('2', '10', 'ACTIVE')).resolves.toEqual(
      users,
    );
    expect(mockUsersService.findAll).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      status: 'ACTIVE',
    });
  });

  it('should return a user by id', async () => {
    mockUsersService.findOne.mockResolvedValue({ id: 'user-123' });

    await expect(controller.findOne('user-123')).resolves.toEqual({
      id: 'user-123',
    });
    expect(mockUsersService.findOne).toHaveBeenCalledWith('user-123');
  });

  it('should update a user', async () => {
    const dto: UpdateUserDto = { displayName: 'Updated Name' };
    mockUsersService.update.mockResolvedValue({ id: 'user-123', ...dto });

    await expect(controller.update('user-123', dto)).resolves.toMatchObject({
      id: 'user-123',
      displayName: dto.displayName,
    });
    expect(mockUsersService.update).toHaveBeenCalledWith('user-123', dto);
  });

  it('should remove a user', async () => {
    mockUsersService.remove.mockResolvedValue({ id: 'user-123' });

    await expect(controller.remove('user-123')).resolves.toEqual({
      id: 'user-123',
    });
    expect(mockUsersService.remove).toHaveBeenCalledWith('user-123');
  });
});
