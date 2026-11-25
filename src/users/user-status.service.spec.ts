import { Test } from '@nestjs/testing';
import { USER_STATUS, UserStatusPort } from './user-status.service';

describe('USER_STATUS injection token', () => {
  it('is a symbol', () => {
    expect(typeof USER_STATUS).toBe('symbol');
  });

  it('is unique and not registered in the global symbol registry', () => {
    expect(USER_STATUS).not.toBe(Symbol('USER_STATUS'));
    expect(USER_STATUS).not.toBe(Symbol.for('USER_STATUS'));
    expect(Symbol.keyFor(USER_STATUS)).toBeUndefined();
  });

  it('resolves a stub provided under the token', async () => {
    const stub: UserStatusPort = {
      getStatus: jest.fn().mockResolvedValue({ status: 'active' }),
    } as unknown as UserStatusPort;

    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: USER_STATUS, useValue: stub }],
    }).compile();

    expect(moduleRef.get(USER_STATUS)).toBe(stub);
  });

  it('fails resolution when no provider is registered under the token', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [],
    }).compile();

    expect(() => moduleRef.get(USER_STATUS)).toThrow();
  });
});
