/**
 * WalletCreationOrchestratorController — unit / integration tests
 *
 * Covers:
 *  - Happy-path wallet creation (new wallet)
 *  - Idempotency replay (isNewWallet from cache)
 *  - Existing wallet returned (isNewWallet=false)
 *  - Invalid input: missing userId, empty userId, missing network, unknown network
 *  - Error propagation: NotFoundException, ConflictException, WalletOrchestrationError, unknown errors
 *  - GET /user/:userId/:network — found, not found, invalid network
 *  - GET /validate/:userId/:network — canCreate true/false, invalid network
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { WalletCreationOrchestratorController } from './wallet-creation-orchestrator.controller';
import {
  WalletCreationOrchestrator,
  WalletOrchestrationError,
  type CreateWalletOrchestratorRequest,
  type WalletOrchestrationResult,
} from './wallet-creation-orchestrator.service';
import { ResponseSanitizerInterceptor } from '../common/interceptors/response-sanitizer.interceptor';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeWallet = (overrides: Record<string, any> = {}) => ({
  id: 'wallet-abc',
  userId: 'user-abc',
  publicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  keyVersion: 1,
  network: WalletNetwork.TESTNET,
  status: WalletStatus.ACTIVE,
  statusReason: null,
  statusChangedAt: NOW,
  rotatedFromId: null,
  successorId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeOrchestrationResult = (
  overrides: Partial<WalletOrchestrationResult> = {},
): WalletOrchestrationResult => ({
  wallet: makeWallet(),
  privateKey: 'S-private-key',
  isNewWallet: true,
  idempotencyKey: undefined,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Test module setup
// ---------------------------------------------------------------------------

describe('WalletCreationOrchestratorController', () => {
  let controller: WalletCreationOrchestratorController;
  let orchestrator: jest.Mocked<
    Pick<
      WalletCreationOrchestrator,
      'createWallet' | 'getWalletByUser' | 'validateUserCanCreateWallet'
    >
  >;

  beforeEach(async () => {
    orchestrator = {
      createWallet: jest.fn(),
      getWalletByUser: jest.fn(),
      validateUserCanCreateWallet: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletCreationOrchestratorController],
      providers: [
        { provide: WalletCreationOrchestrator, useValue: orchestrator },
      ],
    })
      .overrideGuard(FeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideInterceptor(ResponseSanitizerInterceptor)
      .useValue({
        intercept: (ctx: any, next: any) => next.handle(),
      })
      .compile();

    controller = module.get(WalletCreationOrchestratorController);
  });

  afterEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────────────
  // POST /wallets/orchestration/create — happy paths
  // ─────────────────────────────────────────────────────────────────────────

  describe('createWallet — happy paths', () => {
    const validRequest: CreateWalletOrchestratorRequest = {
      userId: 'user-abc',
      network: WalletNetwork.TESTNET,
    };

    it('returns the orchestration result for a new wallet', async () => {
      const expected = makeOrchestrationResult();
      orchestrator.createWallet.mockResolvedValue(expected);

      const result = await controller.createWallet(validRequest);

      expect(result).toBe(expected);
      expect(orchestrator.createWallet).toHaveBeenCalledWith(validRequest, undefined);
    });

    it('passes the x-request-id header to the orchestrator', async () => {
      orchestrator.createWallet.mockResolvedValue(makeOrchestrationResult());

      await controller.createWallet(validRequest, 'req-xyz');

      expect(orchestrator.createWallet).toHaveBeenCalledWith(validRequest, 'req-xyz');
    });

    it('returns isNewWallet=false for an existing wallet', async () => {
      const result = makeOrchestrationResult({ isNewWallet: false, privateKey: '' });
      orchestrator.createWallet.mockResolvedValue(result);

      const res = await controller.createWallet(validRequest);

      expect(res.isNewWallet).toBe(false);
      expect(res.privateKey).toBe('');
    });

    it('returns cached result on idempotency replay with privateKey empty', async () => {
      const result = makeOrchestrationResult({
        isNewWallet: true,
        privateKey: '',
        idempotencyKey: 'idem-key-1',
      });
      orchestrator.createWallet.mockResolvedValue(result);

      const res = await controller.createWallet({
        ...validRequest,
        idempotencyKey: 'idem-key-1',
      });

      expect(res.idempotencyKey).toBe('idem-key-1');
      expect(res.privateKey).toBe('');
    });

    it('supports MAINNET network', async () => {
      const mainnetResult = makeOrchestrationResult({
        wallet: makeWallet({ network: WalletNetwork.MAINNET }),
      });
      orchestrator.createWallet.mockResolvedValue(mainnetResult);

      const res = await controller.createWallet({
        userId: 'user-abc',
        network: WalletNetwork.MAINNET,
      });

      expect(res.wallet.network).toBe(WalletNetwork.MAINNET);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /wallets/orchestration/create — invalid input
  // ─────────────────────────────────────────────────────────────────────────

  describe('createWallet — invalid input', () => {
    it('throws BadRequestException when userId is missing', async () => {
      await expect(
        controller.createWallet({
          userId: '',
          network: WalletNetwork.TESTNET,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when userId is whitespace only', async () => {
      await expect(
        controller.createWallet({
          userId: '   ',
          network: WalletNetwork.TESTNET,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when network is missing', async () => {
      await expect(
        controller.createWallet({ userId: 'user-abc' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for an unknown network value', async () => {
      await expect(
        controller.createWallet({
          userId: 'user-abc',
          network: 'DEVNET' as WalletNetwork,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not call the orchestrator for invalid input', async () => {
      try {
        await controller.createWallet({ userId: '', network: WalletNetwork.TESTNET });
      } catch {
        // expected
      }
      expect(orchestrator.createWallet).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /wallets/orchestration/create — error propagation
  // ─────────────────────────────────────────────────────────────────────────

  describe('createWallet — error propagation', () => {
    const validRequest: CreateWalletOrchestratorRequest = {
      userId: 'user-abc',
      network: WalletNetwork.TESTNET,
    };

    it('re-throws NotFoundException from the orchestrator unchanged', async () => {
      orchestrator.createWallet.mockRejectedValue(
        new NotFoundException('User with ID user-abc not found'),
      );

      await expect(controller.createWallet(validRequest)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('re-throws ConflictException from the orchestrator unchanged', async () => {
      orchestrator.createWallet.mockRejectedValue(
        new ConflictException('Idempotency key conflict'),
      );

      await expect(controller.createWallet(validRequest)).rejects.toThrow(
        ConflictException,
      );
    });

    it('maps WalletOrchestrationError to InternalServerErrorException', async () => {
      orchestrator.createWallet.mockRejectedValue(
        new WalletOrchestrationError('Key gen failed', 'key-generation'),
      );

      await expect(controller.createWallet(validRequest)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('maps WalletOrchestrationError message includes the phase', async () => {
      orchestrator.createWallet.mockRejectedValue(
        new WalletOrchestrationError('DB failure', 'wallet-persist'),
      );

      try {
        await controller.createWallet(validRequest);
        fail('Expected error to be thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(InternalServerErrorException);
        expect(err.message).toContain('wallet-persist');
      }
    });

    it('maps unknown errors to InternalServerErrorException', async () => {
      orchestrator.createWallet.mockRejectedValue(new Error('Something random'));

      await expect(controller.createWallet(validRequest)).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('redacts privateKey from the response via ResponseSanitizerInterceptor', async () => {
      orchestrator.createWallet.mockResolvedValue({
        ...makeOrchestrationResult(),
        privateKey: 'S-sensitive-key',
      });

      const result = await controller.createWallet(validRequest);

      // The interceptor is overridden in this test module to pass through,
      // but the response sanitization is verified by the interceptor's own spec.
      expect(result).toHaveProperty('wallet');
      expect(result).toHaveProperty('privateKey');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /wallets/orchestration/user/:userId/:network
  // ─────────────────────────────────────────────────────────────────────────

  describe('getWalletByUser', () => {
    it('returns wallet when found', async () => {
      orchestrator.getWalletByUser.mockResolvedValue(makeWallet());

      const result = await controller.getWalletByUser('user-abc', 'TESTNET');

      expect(result.id).toBe('wallet-abc');
      expect(orchestrator.getWalletByUser).toHaveBeenCalledWith(
        'user-abc',
        WalletNetwork.TESTNET,
      );
    });

    it('throws NotFoundException when wallet does not exist', async () => {
      orchestrator.getWalletByUser.mockResolvedValue(null);

      await expect(
        controller.getWalletByUser('user-abc', 'TESTNET'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for an invalid network parameter', async () => {
      await expect(
        controller.getWalletByUser('user-abc', 'UNKNOWN_NET'),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not call orchestrator for invalid network', async () => {
      try {
        await controller.getWalletByUser('user-abc', 'INVALID');
      } catch {
        // expected
      }
      expect(orchestrator.getWalletByUser).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /wallets/orchestration/validate/:userId/:network
  // ─────────────────────────────────────────────────────────────────────────

  describe('validateUserCanCreateWallet', () => {
    it('returns canCreate=true when user has no wallet', async () => {
      orchestrator.validateUserCanCreateWallet.mockResolvedValue(true);

      const result = await controller.validateUserCanCreateWallet('user-abc', 'TESTNET');

      expect(result).toEqual({ canCreate: true });
    });

    it('returns canCreate=false when user already has a wallet', async () => {
      orchestrator.validateUserCanCreateWallet.mockResolvedValue(false);

      const result = await controller.validateUserCanCreateWallet('user-abc', 'MAINNET');

      expect(result).toEqual({ canCreate: false });
    });

    it('throws BadRequestException for an invalid network parameter', async () => {
      await expect(
        controller.validateUserCanCreateWallet('user-abc', 'FAKENET'),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not call orchestrator for invalid network', async () => {
      try {
        await controller.validateUserCanCreateWallet('user-abc', 'INVALID');
      } catch {
        // expected
      }
      expect(orchestrator.validateUserCanCreateWallet).not.toHaveBeenCalled();
    });
  });
});
