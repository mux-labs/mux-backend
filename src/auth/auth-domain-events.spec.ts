import { Test, TestingModule } from '@nestjs/testing';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { WalletCreationOrchestrator } from '../wallets/wallet-creation-orchestrator.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { WalletNetwork, WalletStatus } from '../wallets/domain/wallet.model';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeUser = (overrides: Record<string, any> = {}) => ({
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

const makeWallet = (overrides: Record<string, any> = {}) => ({
  id: 'wallet-abc',
  userId: 'user-abc',
  publicKey: 'GABC1234567890',
  encryptedSecret: 'enc',
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

describe('AuthOrchestrator — domain event emission', () => {
  let orchestrator: AuthOrchestrator;
  let webhookEventEmitter: jest.Mocked<WebhookEventEmitterService>;

  const mockUserService = {
    findOrCreateUser: jest.fn(),
    findUserByAuthId: jest.fn(),
    listSessions: jest.fn(),
  };
  const mockWalletOrchestrator = {
    getWalletByUser: jest.fn(),
    createWallet: jest.fn(),
  };
  const mockIdempotencyService = {
    getCachedResponse: jest.fn().mockResolvedValue(null),
    cacheResponse: jest.fn().mockResolvedValue(undefined),
  };
  const mockWebhookEventEmitter = {
    emitUserAuthenticated: jest.fn().mockResolvedValue(undefined),
    emitNewUserRegistered: jest.fn().mockResolvedValue(undefined),
    emitAuthenticationFailed: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthOrchestrator,
        { provide: IdempotentUserService, useValue: mockUserService },
        { provide: WalletCreationOrchestrator, useValue: mockWalletOrchestrator },
        { provide: IdempotencyService, useValue: mockIdempotencyService },
        { provide: WebhookEventEmitterService, useValue: mockWebhookEventEmitter },
      ],
    }).compile();

    orchestrator = module.get<AuthOrchestrator>(AuthOrchestrator);
    webhookEventEmitter = module.get(WebhookEventEmitterService);
    jest.clearAllMocks();
    mockIdempotencyService.getCachedResponse.mockResolvedValue(null);
    mockIdempotencyService.cacheResponse.mockResolvedValue(undefined);
    mockWebhookEventEmitter.emitUserAuthenticated.mockResolvedValue(undefined);
    mockWebhookEventEmitter.emitNewUserRegistered.mockResolvedValue(undefined);
    mockWebhookEventEmitter.emitAuthenticationFailed.mockResolvedValue(undefined);
  });

  it('emits auth.new_user_registered for first-time users', async () => {
    const user = makeUser();
    const wallet = makeWallet();

    mockUserService.findOrCreateUser.mockResolvedValue({ user, isNewUser: true });
    mockWalletOrchestrator.getWalletByUser.mockResolvedValue(null);
    mockWalletOrchestrator.createWallet.mockResolvedValue({
      wallet,
      privateKey: 'secret',
      isNewWallet: true,
    });

    await orchestrator.handleAuthentication({ authId: 'auth-abc' });

    // Allow best-effort async emission to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(mockWebhookEventEmitter.emitNewUserRegistered).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        authId: user.authId,
        authProvider: user.authProvider,
        walletId: wallet.id,
        walletNetwork: WalletNetwork.TESTNET,
      }),
    );
    expect(mockWebhookEventEmitter.emitUserAuthenticated).not.toHaveBeenCalled();
  });

  it('emits auth.user_authenticated for returning users', async () => {
    const user = makeUser();
    const wallet = makeWallet();

    mockUserService.findOrCreateUser.mockResolvedValue({ user, isNewUser: false });
    mockWalletOrchestrator.getWalletByUser.mockResolvedValue(wallet);

    await orchestrator.handleAuthentication({ authId: 'auth-abc' });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockWebhookEventEmitter.emitUserAuthenticated).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        authId: user.authId,
        authProvider: user.authProvider,
        isNewWallet: false,
      }),
    );
    expect(mockWebhookEventEmitter.emitNewUserRegistered).not.toHaveBeenCalled();
  });

  it('emits auth.authentication_failed on error', async () => {
    mockUserService.findOrCreateUser.mockRejectedValue(new Error('DB down'));

    await expect(
      orchestrator.handleAuthentication({ authId: 'auth-abc' }),
    ).rejects.toThrow('Authentication failed');

    await new Promise((r) => setTimeout(r, 10));

    expect(mockWebhookEventEmitter.emitAuthenticationFailed).toHaveBeenCalledWith(
      expect.objectContaining({ authId: 'auth-abc', reason: 'DB down' }),
    );
  });

  it('does not throw if event emission fails (best-effort)', async () => {
    const user = makeUser();
    const wallet = makeWallet();

    mockUserService.findOrCreateUser.mockResolvedValue({ user, isNewUser: false });
    mockWalletOrchestrator.getWalletByUser.mockResolvedValue(wallet);
    mockWebhookEventEmitter.emitUserAuthenticated.mockRejectedValue(
      new Error('webhook down'),
    );

    await expect(
      orchestrator.handleAuthentication({ authId: 'auth-abc' }),
    ).resolves.toBeDefined();
  });
});
