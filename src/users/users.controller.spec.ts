import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { FindOrCreateUserDto } from './dto/find-or-create-user.dto';

describe('UsersController - find-or-create request body (ApiProperty)', () => {
  let controller: UsersController;
  let usersService: { findOrCreate: jest.Mock };

  beforeEach(async () => {
    usersService = { findOrCreate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('accepts a body with a caller-supplied authId and forwards it to the service', async () => {
    const dto = plainToInstance(FindOrCreateUserDto, {
      authId: 'auth0|abc123',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);

    usersService.findOrCreate.mockResolvedValue({ id: 'user-1' });

    await controller.findOrCreate(dto);

    expect(usersService.findOrCreate).toHaveBeenCalledTimes(1);
    expect(usersService.findOrCreate).toHaveBeenCalledWith(dto);
  });

  it('rejects a malformed body (missing authId) with 400 before any service call', async () => {
    const dto = plainToInstance(FindOrCreateUserDto, {});

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'authId')).toBe(true);

    // The validation pipe rejects before the handler runs, so the service is never called.
    expect(usersService.findOrCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed body (non-string authId) with 400 before any service call', async () => {
    const dto = plainToInstance(FindOrCreateUserDto, { authId: 12345 });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'authId')).toBe(true);

    expect(usersService.findOrCreate).not.toHaveBeenCalled();
  });
});
