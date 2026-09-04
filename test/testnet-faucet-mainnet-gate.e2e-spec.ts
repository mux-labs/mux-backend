/**
 * Integration test: Testnet faucet mainnet gate
 *
 * Verifies that the faucet service refuses all funding requests when the
 * application is configured to point at the Stellar mainnet (or PUBLIC)
 * network — regardless of NODE_ENV or other configuration.
 *
 * This is a fail-closed gate: misconfigurations must never silently allow
 * Friendbot-style calls against the live Stellar network.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  NotImplementedException,
  TooManyRequestsException,
} from '@nestjs/common';
import {
  TestnetFaucetService,
  FaucetRequest,
} from '../src/wallets/services/testnet-faucet.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const BASE_REQUEST: FaucetRequest = {
  walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXE2E',
  network: 'TESTNET',
  requestedAmount: 100,
};

async function buildFaucetService(
  stellarNetwork: string,
): Promise<TestnetFaucetService> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [
          () => ({
            STELLAR_NETWORK: stellarNetwork,
            TESTNET_FAUCET_URL: 'https://friendbot.stellar.org',
            TESTNET_FAUCET_MAX_REQUESTS: 5,
            TESTNET_FAUCET_WINDOW_MS: 3_600_000,
          }),
        ],
      }),
    ],
    providers: [TestnetFaucetService],
  }).compile();

  return module.get<TestnetFaucetService>(TestnetFaucetService);
}

// ---------------------------------------------------------------------------
// Mainnet gate — fail-closed on all mainnet aliases
// ---------------------------------------------------------------------------

describe('Testnet faucet mainnet gate (e2e integration)', () => {
  afterEach(() => jest.clearAllMocks());

  describe('MAINNET network variants', () => {
    it.each(['MAINNET', 'mainnet', 'Mainnet', 'PUBLIC', 'public'])(
      'should reject funding when STELLAR_NETWORK=%s',
      async (network) => {
        const service = await buildFaucetService(network);

        await expect(service.requestFunds(BASE_REQUEST)).rejects.toThrow(
          NotImplementedException,
        );
        expect(mockedAxios.get).not.toHaveBeenCalled();
      },
    );
  });

  describe('TESTNET network variants', () => {
    it.each(['TESTNET', 'testnet', 'Testnet'])(
      'should allow funding when STELLAR_NETWORK=%s',
      async (network) => {
        mockedAxios.get.mockResolvedValue({ data: { hash: 'tx123' } });

        const service = await buildFaucetService(network);
        const result = await service.requestFunds(BASE_REQUEST);

        expect(result.transactionId).toBe('tx123');
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Regression: the gate must survive a NODE_ENV=production environment
  // -------------------------------------------------------------------------

  describe('NODE_ENV=production with mainnet config', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('should still reject funding in NODE_ENV=production with STELLAR_NETWORK=MAINNET', async () => {
      const service = await buildFaucetService('MAINNET');

      await expect(service.requestFunds(BASE_REQUEST)).rejects.toThrow(
        NotImplementedException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // isMainnetNetwork() helper is exposed for health checks
  // -------------------------------------------------------------------------

  it('isMainnetNetwork() returns true for mainnet', async () => {
    const service = await buildFaucetService('MAINNET');
    expect(service.isMainnetNetwork()).toBe(true);
  });

  it('isMainnetNetwork() returns false for testnet', async () => {
    mockedAxios.get.mockResolvedValue({ data: {} });
    const service = await buildFaucetService('TESTNET');
    expect(service.isMainnetNetwork()).toBe(false);
  });
});
