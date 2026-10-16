import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { UserStatusService, UserStatusStore } from './user-status.service';

interface StubStore extends UserStatusStore {
  findUnique: jest.Mock;
}

function createStore(user: { status: string } | null): StubStore {
  return {
    findUnique: jest.fn().mockResolvedValue(user),
  } as unknown as StubStore;
}

async function createService(
  nodeEnv: string,
  store: UserStatusStore | null,
): Promise<UserStatusService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      UserStatusService,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) =>
            key === 'NODE_ENV' ? nodeEnv : undefined,
          ),
        },
      },
    ],
  }).compile();

  const service = moduleRef.get(UserStatusService);
  if (store) {
    (service as unknown as { store: UserStatusStore | null }).store = store;
  }
  return service;
}

describe('UserStatusService', () => {
  describe('allowWhenUnverifiable derivation', () => {
    it.each([
      ['production', false],
      ['staging', false],
      ['test', true],
      ['development', true],
    ])('is %s -> %s', async (nodeEnv, expected) => {
      const service = await createService(nodeEnv, null);
      expect(
        (service as unknown as { allowWhenUnverifiable: boolean })
          .allowWhenUnverifiable,
      ).toBe(expected);
    });
  });

  describe('resolveStore caching', () => {
    it('reuses the resolved store across assertCanTransact calls', async () => {
      const store = createStore({ status: 'ACTIVE' });
      const service = await createService('test', store);

      await service.assertCanTransact('user-1');
      await service.assertCanTransact('user-1');

      expect(store.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('assertCanTransact', () => {
    it('does not throw for an ACTIVE user', async () => {
      const store = createStore({ status: 'ACTIVE' });
      const service = await createService('test', store);

      await expect(service.assertCanTransact('user-1')).resolves.toBeUndefined();
    });
  });
});
