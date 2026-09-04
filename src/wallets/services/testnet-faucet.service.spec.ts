import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TooManyRequestsException } from '@nestjs/common';
import { TestnetFaucetService, FaucetRequest } from './testnet-faucet.service';

describe('TestnetFaucetService', () => {
  let service: TestnetFaucetService;
  let configService: any;

  beforeEach(async () => {
    configService = {
      get: jest.fn((key: string, defaultValue: any) => {
        const config: Record<string, any> = {
          TESTNET_FAUCET_MAX_REQUESTS: 3,
          TESTNET_FAUCET_WINDOW_MS: 3600000, // 1 hour
          TESTNET_FAUCET_URL: 'https://faucet.testnet.example.com',
        };
        return config[key] ?? defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestnetFaucetService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<TestnetFaucetService>(TestnetFaucetService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('requestFunds', () => {
    it('should successfully request funds for new wallet', async () => {
      const request: FaucetRequest = {
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        network: 'TESTNET',
        requestedAmount: 100,
      };

      const response = await service.requestFunds(request);

      expect(response).toBeDefined();
      expect(response.walletAddress).toBe(request.walletAddress);
      expect(response.amountSent).toBe(100);
      expect(response.transactionId).toBeDefined();
      expect(response.timestamp).toBeInstanceOf(Date);
    });

    it('should use default amount when not specified', async () => {
      const request: FaucetRequest = {
        walletAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        network: 'TESTNET',
      };

      const response = await service.requestFunds(request);

      expect(response.amountSent).toBe(100); // default
    });

    it('should allow multiple requests within throttle window', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      const request1 = await service.requestFunds({
        walletAddress,
        network: 'TESTNET',
      });
      const request2 = await service.requestFunds({
        walletAddress,
        network: 'TESTNET',
      });
      const request3 = await service.requestFunds({
        walletAddress,
        network: 'TESTNET',
      });

      expect(request1.transactionId).toBeDefined();
      expect(request2.transactionId).toBeDefined();
      expect(request3.transactionId).toBeDefined();
    });

    it('should throw TooManyRequestsException when throttle limit exceeded', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const request: FaucetRequest = {
        walletAddress,
        network: 'TESTNET',
      };

      await service.requestFunds(request);
      await service.requestFunds(request);
      await service.requestFunds(request);

      // Fourth request should fail
      await expect(service.requestFunds(request)).rejects.toThrow(
        TooManyRequestsException,
      );
    });

    it('should include retry information in throttle error', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const request: FaucetRequest = {
        walletAddress,
        network: 'TESTNET',
      };

      await service.requestFunds(request);
      await service.requestFunds(request);
      await service.requestFunds(request);

      try {
        await service.requestFunds(request);
        fail('Should have thrown TooManyRequestsException');
      } catch (error) {
        expect(error).toBeInstanceOf(TooManyRequestsException);
        expect((error as any).message).toContain('Retry after');
      }
    });
  });

  describe('throttle tracking', () => {
    it('should track separate throttle entries per wallet', async () => {
      const wallet1 = 'GWALLET1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const wallet2 = 'GWALLET2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      await service.requestFunds({ walletAddress: wallet1, network: 'TESTNET' });
      await service.requestFunds({ walletAddress: wallet2, network: 'TESTNET' });

      const info1 = service.getThrottleInfo(wallet1);
      const info2 = service.getThrottleInfo(wallet2);

      expect(info1?.count).toBe(1);
      expect(info2?.count).toBe(1);
    });

    it('should reset throttle after window expires', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const request: FaucetRequest = {
        walletAddress,
        network: 'TESTNET',
      };

      await service.requestFunds(request);
      const info1 = service.getThrottleInfo(walletAddress);
      expect(info1?.count).toBe(1);

      // Clear and recreate service with very short window for testing
      service.clearThrottleEntry(walletAddress);

      const info2 = service.getThrottleInfo(walletAddress);
      expect(info2).toBeUndefined();
    });
  });

  describe('getThrottleInfo', () => {
    it('should return throttle info for active wallet', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      await service.requestFunds({
        walletAddress,
        network: 'TESTNET',
      });

      const info = service.getThrottleInfo(walletAddress);

      expect(info).toBeDefined();
      expect(info?.count).toBe(1);
      expect(info?.firstRequestAt).toBeInstanceOf(Date);
      expect(info?.lastRequestAt).toBeInstanceOf(Date);
    });

    it('should return undefined for unknown wallet', () => {
      const info = service.getThrottleInfo('GUNKNOWN');
      expect(info).toBeUndefined();
    });
  });

  describe('clearThrottleEntry', () => {
    it('should clear throttle entry for specific wallet', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      await service.requestFunds({
        walletAddress,
        network: 'TESTNET',
      });

      let info = service.getThrottleInfo(walletAddress);
      expect(info).toBeDefined();

      service.clearThrottleEntry(walletAddress);

      info = service.getThrottleInfo(walletAddress);
      expect(info).toBeUndefined();
    });
  });

  describe('clearAllThrottleEntries', () => {
    it('should clear all throttle entries', async () => {
      await service.requestFunds({
        walletAddress: 'GWALLET1',
        network: 'TESTNET',
      });
      await service.requestFunds({
        walletAddress: 'GWALLET2',
        network: 'TESTNET',
      });

      let entries = service.getAllThrottleEntries();
      expect(entries.size).toBe(2);

      service.clearAllThrottleEntries();

      entries = service.getAllThrottleEntries();
      expect(entries.size).toBe(0);
    });
  });

  describe('throttle window behavior', () => {
    it('should enforce max requests per window', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const maxRequests = 3;

      // Make max requests
      for (let i = 0; i < maxRequests; i++) {
        const response = await service.requestFunds({
          walletAddress,
          network: 'TESTNET',
        });
        expect(response.transactionId).toBeDefined();
      }

      // Next request should fail
      await expect(
        service.requestFunds({
          walletAddress,
          network: 'TESTNET',
        }),
      ).rejects.toThrow(TooManyRequestsException);
    });

    it('should track first and last request times', async () => {
      const walletAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      const first = new Date();
      await service.requestFunds({
        walletAddress,
        network: 'TESTNET',
      });

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      await service.requestFunds({
        walletAddress,
        network: 'TESTNET',
      });
      const last = new Date();

      const info = service.getThrottleInfo(walletAddress);
      expect(info?.firstRequestAt.getTime()).toBeLessThanOrEqual(
        first.getTime(),
      );
      expect(info?.lastRequestAt.getTime()).toBeGreaterThanOrEqual(
        last.getTime(),
      );
    });
  });
});
