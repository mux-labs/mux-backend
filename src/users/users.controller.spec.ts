import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: { findOrCreateUser: jest.Mock };

  beforeEach(async () => {
    usersService = { findOrCreateUser: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  describe('findOrCreate', () => {
    it('throws UnauthorizedException and does not create a user when req.apiKey is absent', async () => {
      const req = {} as any;
      const body = { externalId: 'ext-1' } as any;

      await expect(controller.findOrCreate(req, body)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(usersService.findOrCreateUser).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException and does not create a user when apiKey.developer is undefined', async () => {
      const req = { apiKey: { project: { roles: ['admin'] } } } as any;
      const body = { externalId: 'ext-2' } as any;

      await expect(controller.findOrCreate(req, body)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(usersService.findOrCreateUser).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException and does not create a user when developer.id is missing', async () => {
      const req = { apiKey: { developer: {}, project: { roles: [] } } } as any;
      const body = { externalId: 'ext-3' } as any;

      await expect(controller.findOrCreate(req, body)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(usersService.findOrCreateUser).not.toHaveBeenCalled();
    });

    it('forwards the resolved actor context when apiKey.developer.id is present', async () => {
      const req = {
        apiKey: { developer: { id: 'dev-1' }, project: { roles: ['admin'] } },
      } as any;
      const body = { externalId: 'ext-4' } as any;
      const expected = { id: 'user-1' };
      usersService.findOrCreateUser.mockResolvedValue(expected);

      await expect(controller.findOrCreate(req, body)).resolves.toBe(expected);
      expect(usersService.findOrCreateUser).toHaveBeenCalledWith(body, {
        actorId: 'dev-1',
        roles: ['admin'],
      });
    });
  });
});
