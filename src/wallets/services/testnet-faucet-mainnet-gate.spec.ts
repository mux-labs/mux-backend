import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotImplementedException, HttpException } from '@nestjs/common';
import { TestnetFaucetService, FaucetRequest } from './testnet-faucet.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeConfigService(overrides: Record<string, any> = {}): any {
  return {
    get: jest.fn((key: string, defaultValue: any) => {
      const config: Record<string, any> = {
        TESTNET_FAUCET_MAX_REQUESTS: 3,
        TESTNET_FAUCET_WINDOW_MS: 3_600_000,
        TESTNET_FAUCET_URL: 'https://friendbot.stellar.org',
        STELLAR_NETWORK: 'TESTNET',
        ...overrides,
      };
      return config[key] ?? defaultValue;
    }),
  };
}

async function buildService(
  overrides: Record<string, any> = {},
): Promise<TestnetFaucetService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      TestnetFaucetService,
      { provide: ConfigService, useValue: makeConfigService(overrides) },
    ],
  }).compile();
  return module.get<TestnetFaucetService>(TestnetFaucetService);
}

const TESTNET_REQUEST: FaucetRequest = {
  walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  network: 'TESTNET',
  requestedAmount: 100,
};

// ---------------------------------------------------------------------------
// MAINNET GATE — core acceptance criterion
// ---------------------------------------------------------------------------

describe('TestnetFaucetService — mainnet gate (fail-closed)', () => {
  it('should throw NotImplementedException when STELLAR_NETWORK=MAINNET', async () => {
    const service = await buildService({ STELLAR_NETWORK: 'MAINNET' });

    await expect(service.requestFunds(TESTNET_REQUEST)).rejects.toThrow(
      NotImplementedException,
    );
  });

  it('should throw NotImplementedException when STELLAR_NETWORK=mainnet (lower-case)', async () => {
    const service = await buildService({ STELLAR_NETWORK: 'mainnet' });

    await expect(service.requestFunds(TESTNET_REQUEST)).rejects.toThrow(
      NotImplementedException,
    );
  });

  it('should throw NotImplementedException when STELLAR_NETWORK=PUBLIC (Stellar mainnet alias)', async () => {
    const service = await buildService({ STELLAR_NETWORK: 'PUBLIC' });

    await expect(service.requestFunds(TESTNET_REQUEST)).rejects.toThrow(
      NotImplementedException,
    );
  });

  it('should include a descriptive message in the mainnet rejection', async () => {
    const service = await buildService({ STELLAR_NETWORK: 'MAINNET' });

    try {
      await service.requestFunds(TESTNET_REQUEST);
      fail('Expected NotImplementedException');
    } catch (err) {
      expect((err as NotImplementedException).message).toContain('mainnet');
      expect((err as NotImplementedException).message).toContain('TESTNET');
    }
  });

  it('isMainnetNetwork() should return true when STELLAR_NETWORK=MAINNET', async () => {
    const service = await buildService({ STELLAR_NETWORK: 'MAINNET' });
    expect(service.isMainnetNetwork()).toBe(true);
  });

  it('isMainnetNetwork() should return false when STELLAR_NETWORK=TESTNET', async () => {
    const service = await buildService({ STELLAR_NETWORK: 'TESTNET' });
    expect(service.isMainnetNetwork()).toBe(false);
  });

  it('should NOT call the faucet HTTP endpoint when mainnet is detected', async () => {
    const service = await buildService({ STELLAR_NETWORK: 'MAINNET' });

    await expect(service.requestFunds(TESTNET_REQUEST)).rejects.toThrow(
      NotImplementedException,
    );

    // axios should never have been called
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TESTNET path — should work and call the real faucet URL
// ---------------------------------------------------------------------------

describe('TestnetFaucetService — testnet path', () => {
  let service: TestnetFaucetService;

  beforeEach(async () => {
    jest.clearAllMocks();
    service = await buildService({ STELLAR_NETWORK: 'TESTNET' });
  });

  it('should call the Friendbot URL with the wallet address', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hash: 'abc123tx' },
    });

    const result = await service.requestFunds(TESTNET_REQUEST);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining(
        encodeURIComponent(TESTNET_REQUEST.walletAddress),
      ),
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(result.transactionId).toBe('abc123tx');
    expect(result.walletAddress).toBe(TESTNET_REQUEST.walletAddress);
  });

  it('should use the id field as transactionId when hash is absent', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { id: 'txid-fallback' },
    });

    const result = await service.requestFunds({
      ...TESTNET_REQUEST,
      walletAddress: 'GTEST2',
    });

    expect(result.transactionId).toBe('txid-fallback');
  });

  it('should generate a fallback transactionId when neither hash nor id is present', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: {} });

    const result = await service.requestFunds({
      ...TESTNET_REQUEST,
      walletAddress: 'GTEST3',
    });

    expect(result.transactionId).toMatch(/^faucet_/);
  });

  it('should propagate axios errors as-is (not swallowed)', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('network timeout'));

    await expect(service.requestFunds(TESTNET_REQUEST)).rejects.toThrow(
      'network timeout',
    );
  });

  it('should enforce throttle limits on testnet', async () => {
    mockedAxios.get.mockResolvedValue({ data: { hash: 'tx' } });

    const wallet = 'GWALLET_THROTTLE_TEST';
    const req: FaucetRequest = { walletAddress: wallet, network: 'TESTNET' };

    // Exhaust the limit (3 from config)
    await service.requestFunds(req);
    await service.requestFunds(req);
    await service.requestFunds(req);

    await expect(service.requestFunds(req)).rejects.toThrow(
      HttpException,
    );
  });
});

// ---------------------------------------------------------------------------
// Guard regression — ensure mainnet gate cannot be bypassed in production mode
// ---------------------------------------------------------------------------

describe('TestnetFaucetService — mainnet gate regression guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should still reject mainnet requests when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';

    const service = await buildService({ STELLAR_NETWORK: 'MAINNET' });

    await expect(service.requestFunds(TESTNET_REQUEST)).rejects.toThrow(
      NotImplementedException,
    );
  });
});
