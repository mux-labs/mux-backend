import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from './api-key.service';
import { ApiKeyStatus } from './domain/api-key.model';
import { NetworkErrorCode } from '../common/network/network-mismatch';

/**
 * Minimal structural stub of the `ApiKeyStore` interface declared in
 * `api-key.service.ts`. The interface is structural precisely so the service
 * can be exercised without Prisma.
 */
class StubApiKeyStore {
  findUnique = jest.fn();
  update = jest.fn();
}

function makeConfig(): ConfigService {
  const values: Record<string, string> = {
    API_KEY_HASH_SECRET: 'test-secret',
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    hashedKey: 'hashed',
    status: ApiKeyStatus.ACTIVE,
    network: null,
    expiresAt: null,
    ...overrides,
  };
}

function buildService(store: StubApiKeyStore): ApiKeyService {
  return new ApiKeyService(store as never, makeConfig());
}

describe('ApiKeyService', () => {
  let store: StubApiKeyStore;
  let service: ApiKeyService;

  beforeEach(() => {
    store = new StubApiKeyStore();
    service = buildService(store);
  });

  it('rejects a REVOKED key without mutating the store', async () => {
    store.findUnique.mockResolvedValue(
      makeRow({ status: ApiKeyStatus.REVOKED }),
    );

    await expect(service.validateApiKey('raw-key')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.validateApiKey('raw-key')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'API_KEY_REVOKED' }),
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it('rejects an expired key and marks it EXPIRED exactly once', async () => {
    store.findUnique.mockResolvedValue(
      makeRow({ expiresAt: new Date(Date.now() - 60_000) }),
    );
    store.update.mockResolvedValue(
      makeRow({ status: ApiKeyStatus.EXPIRED }),
    );

    await expect(service.validateApiKey('raw-key')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ApiKeyStatus.EXPIRED }),
      }),
    );
  });

  it('rejects a TESTNET-scoped key used on MAINNET with NETWORK_MISMATCH', async () => {
    store.findUnique.mockResolvedValue(
      makeRow({ network: 'TESTNET' }),
    );

    await expect(
      service.validateApiKey('raw-key', 'MAINNET'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: NetworkErrorCode.NETWORK_MISMATCH,
      }),
    });
    await expect(
      service.validateApiKey('raw-key', 'MAINNET'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed with 503 when the store read throws', async () => {
    store.findUnique.mockRejectedValue(new Error('db down'));

    await expect(service.validateApiKey('raw-key')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  describe('offline verifier gating', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    function buildGatedService(nodeEnv: string | undefined): {
      service: ApiKeyService;
      store: StubApiKeyStore;
    } {
      if (nodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = nodeEnv;
      }
      const gatedStore = new StubApiKeyStore();
      gatedStore.findUnique.mockResolvedValue(null);
      const gatedService = new ApiKeyService(
        gatedStore as never,
        makeConfig(),
      );
      return { service: gatedService, store: gatedStore };
    }

    it('rejects an unknown key under NODE_ENV=production', async () => {
      const { service: gated } = buildGatedService('production');
      await expect(gated.validateApiKey('mux_test_unknown')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an unknown key under NODE_ENV=staging', async () => {
      const { service: gated } = buildGatedService('staging');
      await expect(gated.validateApiKey('mux_test_unknown')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an unknown key when NODE_ENV is unset', async () => {
      const { service: gated } = buildGatedService(undefined);
      await expect(gated.validateApiKey('mux_test_unknown')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('allows a mux_test_ prefixed key under NODE_ENV=test', async () => {
      const { service: gated } = buildGatedService('test');
      const context = await gated.validateApiKey('mux_test_offline');
      expect(context).toBeDefined();
    });

    it('treats whitespace/case NODE_ENV=" TEST " as test', async () => {
      const { service: gated } = buildGatedService(' TEST ');
      const context = await gated.validateApiKey('mux_test_offline');
      expect(context).toBeDefined();
    });
  });
});

describe('lifetime (key store)', () => {
  it('the key store can be assigned by construction and replaced directly with a stub in tests', async () => {
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new ApiKeyService(config);

    const stubStore = {
      apiKey: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'key-1',
          name: 'Test key',
          projectId: 'proj-1',
          network: null,
          status: 'ACTIVE',
          expiresAt: null,
          lastFour: 'abcd',
          keyPrefix: 'mux_test_',
        }),
      },
    };

    // Tests may replace the store directly with a stub.
    (service as any).prisma = stubStore;

    const result = await service.validateApiKey('mux_test_stubbed_key_123456');

    expect(stubStore.apiKey.findUnique).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        id: 'key-1',
        projectId: 'proj-1',
      }),
    );
  });
});
