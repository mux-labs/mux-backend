import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController - remove (#968)', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(() => {
    usersService = {
      findOrCreateUser: jest.fn(),
      findUserByAuthId: jest.fn(),
      remove: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    controller = new UsersController(usersService);
  });

  it('delegates deletion to usersService.remove with the provided user id', async () => {
    const deletedUser = {
      id: 'user-abc',
      authId: 'auth-123',
      status: 'DISABLED',
      deletedAt: new Date('2026-10-01T00:00:00Z'),
    };
    usersService.remove.mockResolvedValue(deletedUser as any);

    const result = await controller.remove('user-abc');

    expect(usersService.remove).toHaveBeenCalledWith('user-abc');
    expect(result).toEqual(deletedUser);
  });
});
