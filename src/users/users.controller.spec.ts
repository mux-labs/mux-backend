import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const mockUsersService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
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
