/**
 * Auth Integration Test Harness (#145)
 *
 * Wires the real AuthOrchestrator with controlled collaborator stubs to
 * exercise the full authentication flow end-to-end without a live database.
 *
 * Covers:
 * - First-time user: user + wallet created, lastLoginAt set, wallet summary returned
 * - Returning user: existing user + wallet returned, lastLoginAt updated
 * - Existing user without wallet: wallet created on re-auth
 * - Error propagation from collaborators
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { WalletCreationOrchestrator } from '../wallets/wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from '../wallets/domain/wallet.model';
import { IdempotencyService } from '../common/idempotency/idempotency.service';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeUser = (overrides: Partial<ReturnType<typeof makeUser>> = {}) => ({
  id: 'user-abc',
  authId: 'auth-abc',
  email: 'user@example.com',
  displayName: 'Test User',
  status: 'ACTIVE',
  authProvider: 'GOOGLE',
  lastLoginAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeWallet = (
  overrides: Partial<ReturnType<typeof makeWallet>> = {},
) => ({
  id: 'wallet-abc',
  userId: 'user-abc',
  publicKey: 'GABC1234567890',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  network: WalletNetwork.TESTNET,
  status: WalletStatus.ACTIVE,
  statusChangedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  rotatedFromId: null,
  statusReason: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Harness setup
// ---------------------------------------------------------------------------

describe('AuthOrchestrator (integration harness)', () => {
  let orchestrator: AuthOrchestrator;
  let userService: jest.Mocked<
    Pick<IdempotentUserService, 'findOrCreateUser' | 'findUserByAuthId'>
  >;
  let walletOrchestrator: jest.Mocked<
    Pick<WalletCreationOrchestrator, 'getWalletByUser' | 'createWallet'>
  >;

  beforeEach(async () => {
    userService = {
      findOrCreateUser: jest.fn(),
      findUserByAuthId: jest.fn(),
    };

    walletOrchestrator = {
      getWalletByUser: jest.fn(),
      createWallet: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthOrchestrator,
        { provide: IdempotentUserService, useValue: userService },
        { provide: WalletCreationOrchestrator, useValue: walletOrchestrator },
        {
          provide: IdempotencyService,
          useValue: {
            getCachedResponse: jest.fn().mockResolvedValue(null),
            cacheResponse: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    orchestrator = module.get(AuthOrchestrator);
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // First-time authentication
  // -------------------------------------------------------------------------

  describe('first-time authentication', () => {
    it('creates user and wallet, returns lastLoginAt and wallet summary', async () => {
      const user = makeUser();
      const wallet = makeWallet();

      userService.findOrCreateUser.mockResolvedValue({ user, isNewUser: true });
      walletOrchestrator.getWalletByUser.mockResolvedValue(null);
      walletOrchestrator.createWallet.mockResolvedValue({
        wallet,
        privateKey: 'secret-key',
        isNewWallet: true,
      });

      const result = await orchestrator.handleAuthentication({
        authId: 'auth-abc',
        email: 'user@example.com',
        displayName: 'Test User',
        authProvider: 'GOOGLE',
      });

      expect(result.isNewUser).toBe(true);
      expect(result.isNewWallet).toBe(true);

      // #143: lastLoginAt must be present
      expect(result.user.lastLoginAt).toEqual(NOW);

      // #144: wallet summary must include createdAt
      expect(result.wallet.createdAt).toEqual(NOW);
      expect(result.wallet.publicKey).toBe('GABC1234567890');
      expect(result.wallet.network).toBe(WalletNetwork.TESTNET);
      expect(result.wallet.status).toBe(WalletStatus.ACTIVE);

      expect(walletOrchestrator.createWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-abc',
          network: WalletNetwork.TESTNET,
        }),
      );
    });

    it('defaults to TESTNET when no network is specified', async () => {
      userService.findOrCreateUser.mockResolvedValue({
        user: makeUser(),
        isNewUser: true,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(null);
      walletOrchestrator.createWallet.mockResolvedValue({
        wallet: makeWallet(),
        privateKey: 'secret-key',
        isNewWallet: true,
      });

      const result = await orchestrator.handleAuthentication({
        authId: 'auth-abc',
      });

      expect(result.wallet.network).toBe(WalletNetwork.TESTNET);
    });
  });

  // -------------------------------------------------------------------------
  // Returning user authentication
  // -------------------------------------------------------------------------

  describe('returning user authentication', () => {
    it('returns existing user and wallet without creating new ones', async () => {
      const user = makeUser();
      const wallet = makeWallet();

      userService.findOrCreateUser.mockResolvedValue({
        user,
        isNewUser: false,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(wallet);

      const result = await orchestrator.handleAuthentication({
        authId: 'auth-abc',
      });

      expect(result.isNewUser).toBe(false);
      expect(result.isNewWallet).toBe(false);
      expect(result.user.lastLoginAt).toEqual(NOW);
      expect(result.wallet.createdAt).toEqual(NOW);
      expect(walletOrchestrator.createWallet).not.toHaveBeenCalled();
    });

    it('creates wallet for existing user who has none', async () => {
      const user = makeUser();
      const wallet = makeWallet();

      userService.findOrCreateUser.mockResolvedValue({
        user,
        isNewUser: false,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(null);
      walletOrchestrator.createWallet.mockResolvedValue({
        wallet,
        privateKey: 'secret-key',
        isNewWallet: true,
      });

      const result = await orchestrator.handleAuthentication({
        authId: 'auth-abc',
      });

      expect(result.isNewUser).toBe(false);
      expect(result.isNewWallet).toBe(true);
      expect(walletOrchestrator.createWallet).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  describe('error propagation', () => {
    it('wraps user service errors in an Authentication failed error', async () => {
      userService.findOrCreateUser.mockRejectedValue(
        new Error('DB unavailable'),
      );

      await expect(
        orchestrator.handleAuthentication({ authId: 'auth-abc' }),
      ).rejects.toThrow('Authentication failed: DB unavailable');
    });

    it('wraps wallet creation errors in an Authentication failed error', async () => {
      userService.findOrCreateUser.mockResolvedValue({
        user: makeUser(),
        isNewUser: true,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(null);
      walletOrchestrator.createWallet.mockRejectedValue(
        new Error('Stellar unavailable'),
      );

      await expect(
        orchestrator.handleAuthentication({ authId: 'auth-abc' }),
      ).rejects.toThrow('Authentication failed: Stellar unavailable');
    });
  });

  // -------------------------------------------------------------------------
  // validateAuthentication
  // -------------------------------------------------------------------------

  describe('validateAuthentication', () => {
    it('returns true for an existing user', async () => {
      userService.findUserByAuthId.mockResolvedValue(makeUser());
      await expect(
        orchestrator.validateAuthentication('auth-abc'),
      ).resolves.toBe(true);
    });

    it('returns true for an unknown authId (new user path)', async () => {
      userService.findUserByAuthId.mockResolvedValue(null);
      await expect(orchestrator.validateAuthentication('new-id')).resolves.toBe(
        true,
      );
    });

    it('returns false when the lookup throws', async () => {
      userService.findUserByAuthId.mockRejectedValue(new Error('DB error'));
      await expect(
        orchestrator.validateAuthentication('auth-abc'),
      ).resolves.toBe(false);
    });
  });
});
