import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdempotentUserService } from './idempotent-user.service';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let idempotentUserService: {
    findOrCreateUser: jest.Mock;
    findUserByAuthId: jest.Mock;
  };

  beforeEach(async () => {
    idempotentUserService = {
      findOrCreateUser: jest.fn(),
      findUserByAuthId: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: IdempotentUserService, useValue: idempotentUserService },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('findOrCreateUser', () => {
    it('forwards all four arguments unchanged to IdempotentUserService', async () => {
      const authId = 'auth-123';
      const actorContext = { actorId: 'actor-1', roles: ['user'] };
      const idempotencyKey = 'idem-key-1';
      const requestContext = { requestId: 'req-1', ip: '127.0.0.1' };
      const expected = { id: 'user-1', authId };
      idempotentUserService.findOrCreateUser.mockResolvedValue(expected);

      const result = await service.findOrCreateUser(
        authId,
        actorContext as any,
        idempotencyKey,
        requestContext as any,
      );

      expect(idempotentUserService.findOrCreateUser).toHaveBeenCalledTimes(1);
      expect(idempotentUserService.findOrCreateUser).toHaveBeenCalledWith(
        authId,
        actorContext,
        idempotencyKey,
        requestContext,
      );
      expect(result).toBe(expected);
    });

    it('throws BadRequestException for an empty authId and does not delegate', async () => {
      await expect(
        service.findOrCreateUser('', {} as any, 'idem-key-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(idempotentUserService.findOrCreateUser).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for a non-string authId and does not delegate', async () => {
      await expect(
        service.findOrCreateUser(undefined as any, {} as any, 'idem-key-1', {} as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(idempotentUserService.findOrCreateUser).not.toHaveBeenCalled();
    });
  });

  describe('findUserByAuthId', () => {
    it('forwards the single authId argument to IdempotentUserService', async () => {
      const authId = 'auth-456';
      const expected = { id: 'user-2', authId };
      idempotentUserService.findUserByAuthId.mockResolvedValue(expected);

      const result = await service.findUserByAuthId(authId);

      expect(idempotentUserService.findUserByAuthId).toHaveBeenCalledTimes(1);
      expect(idempotentUserService.findUserByAuthId).toHaveBeenCalledWith(authId);
      expect(result).toBe(expected);
    });

    it('throws BadRequestException for an empty authId and does not delegate', async () => {
      await expect(service.findUserByAuthId('')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(idempotentUserService.findUserByAuthId).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for a non-string authId and does not delegate', async () => {
      await expect(service.findUserByAuthId(undefined as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(idempotentUserService.findUserByAuthId).not.toHaveBeenCalled();
    });
  });
});
