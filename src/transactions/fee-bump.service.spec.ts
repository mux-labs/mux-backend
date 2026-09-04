import {
  BadRequestException,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { FeeBumpService } from './fee-bump.service';
import { TransactionStatus } from './domain/transaction.model';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

// Mock stellar-sdk so tests don't need the actual Stellar package
jest.mock('stellar-sdk', () => {
  const originalModule = jest.requireActual('stellar-sdk');

  const MockTransaction = jest.fn().mockImplementation((xdr: string) => {
    if (xdr === 'BAD_XDR') throw new Error('invalid XDR');
    return { source: 'GSOURCE...' };
  });

  const MockKeypair = {
    fromSecret: jest.fn().mockReturnValue({
      publicKey: jest.fn().mockReturnValue('GFEE_SOURCE_PUBLIC_KEY'),
      secret: jest.fn().mockReturnValue('SECRET'),
    }),
  };

  const buildFeeBumpTransaction = jest.fn().mockReturnValue({
    sign: jest.fn(),
    toEnvelope: jest.fn().mockReturnValue({
      toXDR: jest.fn().mockReturnValue('BASE64_FEE_BUMP_XDR'),
    }),
  });

  const MockTransactionBuilder = {
    buildFeeBumpTransaction,
  };

  return {
    ...originalModule,
    Transaction: MockTransaction,
    Keypair: MockKeypair,
    TransactionBuilder: MockTransactionBuilder,
    Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
    BASE_FEE: '100',
    Server: jest.fn().mockImplementation(() => ({})),
  };
});

// Mock the request-id-aware axios factory used by FeeBumpService
jest.mock('../common/http/request-id-axios', () => ({
  createRequestIdAwareAxios: jest.fn().mockReturnValue({
    post: jest.fn(),
  }),
}));

import { createRequestIdAwareAxios } from '../common/http/request-id-axios';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(overrides: {
  horizonPost?: jest.Mock;
  getDecryptedPrivateKey?: jest.Mock;
  updateStatus?: jest.Mock;
  mainnetPaymentSubmitEnabled?: boolean;
  feeBumpMaxFee?: number;
  metrics?: { incrementFeeBumpCapRejection: jest.Mock };
}) {
  const mockHttp = (createRequestIdAwareAxios as jest.Mock)();
  if (overrides.horizonPost) {
    mockHttp.post = overrides.horizonPost;
  }

  const mockWalletsService = {
    getDecryptedPrivateKey:
      overrides.getDecryptedPrivateKey ??
      jest.fn().mockResolvedValue('STELLAR_SECRET'),
  };

  const mockTransactionsService = {
    updateStatus:
      overrides.updateStatus ?? jest.fn().mockResolvedValue(undefined),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue: string) => {
      if (key === 'FEE_BUMP_MAX_FEE' && overrides.feeBumpMaxFee !== undefined) {
        return String(overrides.feeBumpMaxFee);
      }
      return defaultValue;
    }),
  };

  const mockFeatureFlagService = {
    isEnabled: jest
      .fn()
      .mockReturnValue(overrides.mainnetPaymentSubmitEnabled ?? true),
  };

  const mockMetrics = overrides.metrics ?? {
    incrementFeeBumpCapRejection: jest.fn(),
  };

  const service = new FeeBumpService(
    mockConfigService as any,
    mockWalletsService as any,
    mockTransactionsService as any,
    mockFeatureFlagService as any,
    mockMetrics as any,
  );

  // Inject the mock http directly
  (service as any).http = mockHttp;

  return {
    service,
    mockHttp,
    mockWalletsService,
    mockTransactionsService,
    mockFeatureFlagService,
    mockMetrics,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeBumpService', () => {
  const VALID_DTO = {
    innerTransactionXdr: 'VALID_XDR',
    feeSourcePublicKey: 'GFEE_SOURCE_PUBLIC_KEY',
    feeSourceWalletId: 'wallet-fee-1',
    transactionId: 'tx-1',
    network: 'TESTNET' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------
  describe('submitFeeBump – success', () => {
    it('builds, signs, and submits the fee-bump XDR, returning the result', async () => {
      const mockPost = jest.fn().mockResolvedValue({
        data: {
          hash: 'abc123hash',
          fee_charged: '1000',
          successful: true,
          ledger: 12345,
        },
        status: 200,
      });

      const { service, mockTransactionsService } = makeService({
        horizonPost: mockPost,
      });

      const result = await service.submitFeeBump(VALID_DTO);

      expect(result.stellarHash).toBe('abc123hash');
      expect(result.feeCharged).toBe('1000');
      expect(result.transactionId).toBe('tx-1');
      expect(result.status).toBe(TransactionStatus.CONFIRMED);

      // Status should be persisted on the internal transaction
      expect(mockTransactionsService.updateStatus).toHaveBeenCalledWith(
        'tx-1',
        expect.objectContaining({ stellarHash: 'abc123hash' }),
      );
    });

    it('works without a transactionId (does not call updateStatus)', async () => {
      const mockPost = jest.fn().mockResolvedValue({
        data: { hash: 'xyz789', successful: true },
        status: 200,
      });

      const { service, mockTransactionsService } = makeService({
        horizonPost: mockPost,
      });

      await service.submitFeeBump({ ...VALID_DTO, transactionId: undefined });

      expect(mockTransactionsService.updateStatus).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Mainnet feature flag
  // -------------------------------------------------------------------------
  describe('submitFeeBump – mainnet_payment_submit feature flag', () => {
    it('rejects MAINNET submission with 403 when the flag is disabled', async () => {
      const mockPost = jest.fn();
      const { service, mockFeatureFlagService } = makeService({
        horizonPost: mockPost,
        mainnetPaymentSubmitEnabled: false,
      });

      await expect(
        service.submitFeeBump({ ...VALID_DTO, network: 'MAINNET' }),
      ).rejects.toThrow(HttpException);

      expect(mockFeatureFlagService.isEnabled).toHaveBeenCalledWith(
        'mainnet_payment_submit',
      );
      // Never reaches Horizon once the flag denies the request.
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('allows MAINNET submission when the flag is enabled', async () => {
      const mockPost = jest.fn().mockResolvedValue({
        data: { hash: 'mainnet-hash', successful: true },
        status: 200,
      });
      const { service } = makeService({
        horizonPost: mockPost,
        mainnetPaymentSubmitEnabled: true,
      });

      const result = await service.submitFeeBump({
        ...VALID_DTO,
        network: 'MAINNET',
      });

      expect(result.stellarHash).toBe('mainnet-hash');
      expect(mockPost).toHaveBeenCalled();
    });

    it('does not consult the flag for TESTNET submissions', async () => {
      const mockPost = jest.fn().mockResolvedValue({
        data: { hash: 'testnet-hash', successful: true },
        status: 200,
      });
      const { service, mockFeatureFlagService } = makeService({
        horizonPost: mockPost,
        mainnetPaymentSubmitEnabled: false,
      });

      await service.submitFeeBump({ ...VALID_DTO, network: 'TESTNET' });

      expect(mockFeatureFlagService.isEnabled).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Failure paths
  // -------------------------------------------------------------------------
  describe('submitFeeBump – validation failures', () => {
    it('throws BadRequestException for invalid inner XDR', async () => {
      const { service } = makeService({});

      await expect(
        service.submitFeeBump({ ...VALID_DTO, innerTransactionXdr: 'BAD_XDR' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when feeSourcePublicKey does not match wallet key', async () => {
      const { service } = makeService({});

      await expect(
        service.submitFeeBump({
          ...VALID_DTO,
          feeSourcePublicKey: 'GWRONG_KEY',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-throws non-NotFoundException errors from getDecryptedPrivateKey', async () => {
      const { service } = makeService({
        getDecryptedPrivateKey: jest
          .fn()
          .mockRejectedValue(new Error('vault offline')),
      });

      await expect(service.submitFeeBump(VALID_DTO)).rejects.toThrow(
        'vault offline',
      );
    });
  });

  describe('submitFeeBump – fee-bump sponsorship cap (#800)', () => {
    it('refuses submission when the computed fee exceeds the configured cap', async () => {
      const mockPost = jest.fn();
      // BASE_FEE is mocked to 100 → computed fee = 1000 stroops; cap = 10.
      const { service, mockMetrics } = makeService({
        horizonPost: mockPost,
        feeBumpMaxFee: 10,
        metrics: { incrementFeeBumpCapRejection: jest.fn() },
      });

      await expect(
        service.submitFeeBump(VALID_DTO),
      ).rejects.toThrow(BadRequestException);

      // Must never reach Horizon with an over-cap fee.
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockMetrics.incrementFeeBumpCapRejection).toHaveBeenCalled();
    });

    it('allows submission when the computed fee is within the cap', async () => {
      const mockPost = jest.fn().mockResolvedValue({
        data: { hash: 'within-cap-hash', successful: true },
        status: 200,
      });
      // Computed fee = 1000 stroops; cap = 5000 → allowed.
      const { service, mockMetrics } = makeService({
        horizonPost: mockPost,
        feeBumpMaxFee: 5000,
        metrics: { incrementFeeBumpCapRejection: jest.fn() },
      });

      const result = await service.submitFeeBump(VALID_DTO);

      expect(result.stellarHash).toBe('within-cap-hash');
      expect(mockMetrics.incrementFeeBumpCapRejection).not.toHaveBeenCalled();
    });

    it('fails fast at construction when FEE_BUMP_MAX_FEE is not a positive integer', () => {
      const badConfig = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'FEE_BUMP_MAX_FEE') return '-1';
          return undefined;
        }),
      };
      expect(
        () =>
          new FeeBumpService(
            badConfig as any,
            {} as any,
            {} as any,
            { isEnabled: jest.fn().mockReturnValue(true) } as any,
          ),
      ).toThrow('FEE_BUMP_MAX_FEE must be a positive integer');
    });

    it('requires FEE_BUMP_MAX_FEE in production (fail-closed)', () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const prodConfig = {
          get: jest.fn().mockReturnValue(undefined),
        };
        expect(
          () =>
            new FeeBumpService(
              prodConfig as any,
              {} as any,
              {} as any,
              { isEnabled: jest.fn().mockReturnValue(true) } as any,
            ),
        ).toThrow('FEE_BUMP_MAX_FEE is required in production');
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });

  describe('submitFeeBump – Horizon rejection (4xx)', () => {
    it('throws BadRequestException and persists FAILED status', async () => {
      const { AxiosError } = jest.requireActual('axios');
      const axiosErr = Object.assign(new Error('Bad request'), {
        response: {
          status: 400,
          data: { result_code: 'tx_bad_seq' },
        },
        isAxiosError: true,
      });

      const mockPost = jest.fn().mockRejectedValue(axiosErr);
      const { service, mockTransactionsService } = makeService({
        horizonPost: mockPost,
      });

      await expect(service.submitFeeBump(VALID_DTO)).rejects.toThrow(
        BadRequestException,
      );

      expect(mockTransactionsService.updateStatus).toHaveBeenCalledWith(
        'tx-1',
        expect.objectContaining({ status: TransactionStatus.FAILED }),
      );
    });
  });

  describe('submitFeeBump – Horizon network error', () => {
    it('throws ServiceUnavailableException when Horizon is unreachable', async () => {
      const networkErr = Object.assign(new Error('ECONNREFUSED'), {
        response: undefined,
        isAxiosError: true,
      });

      const mockPost = jest.fn().mockRejectedValue(networkErr);
      const { service } = makeService({ horizonPost: mockPost });

      await expect(service.submitFeeBump(VALID_DTO)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
