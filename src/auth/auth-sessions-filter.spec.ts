import { Test, TestingModule } from '@nestjs/testing';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { WalletCreationOrchestrator } from '../wallets/wallet-creation-orchestrator.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { WalletNetwork } from '../wallets/domain/wallet.model';
import { UserStatus } from '../users/entities/user.entity';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeSessionUser = (overrides: Record<string, any> = {}) => ({
  id: `user-${Math.random()}`,
  authId: `auth-${Math.random()}`,
  email: 'user@example.com',
  displayName: 'Test User',
  status: UserStatus.ACTIVE,
  authProvider: 'GOOGLE',
  lastLoginAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('AuthOrchestrator.listSessions', () => {
  let orchestrator: AuthOrchestrator;
  let idempotentUserService: jest.Mocked<IdempotentUserService>;

  const mockIdempotentUserService = {
    findOrCreateUser: jest.fn(),
    findUserByAuthId: jest.fn(),
    listSessions: jest.fn(),
  };

  const mockWalletCreationOrchestrator = {
    getWalletByUser: jest.fn(),
    createWallet: jest.fn(),
  };

  const mockIdempotencyService = {
    getCachedResponse: jest.fn(),
    cacheResponse: jest.fn(),
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
        { provide: IdempotentUserService, useValue: mockIdempotentUserService },
        {
          provide: WalletCreationOrchestrator,
          useValue: mockWalletCreationOrchestrator,
        },
        { provide: IdempotencyService, useValue: mockIdempotencyService },
        {
          provide: WebhookEventEmitterService,
          useValue: mockWebhookEventEmitter,
        },
      ],
    }).compile();

    orchestrator = module.get<AuthOrchestrator>(AuthOrchestrator);
    idempotentUserService = module.get(IdempotentUserService);
    jest.clearAllMocks();
  });

  it('returns paginated sessions from the user service', async () => {
    const users = [makeSessionUser(), makeSessionUser()];
    mockIdempotentUserService.listSessions.mockResolvedValue({
      data: users,
      total: 2,
      page: 1,
      limit: 20,
    });

    const result = await orchestrator.listSessions({ page: 1, limit: 20 });

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(mockIdempotentUserService.listSessions).toHaveBeenCalledWith({
      page: 1,
      limit: 20,
    });
  });

  it('passes status filter to the user service', async () => {
    mockIdempotentUserService.listSessions.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
    });

    await orchestrator.listSessions({ status: UserStatus.ACTIVE });

    expect(mockIdempotentUserService.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ status: UserStatus.ACTIVE }),
    );
  });

  it('passes authProvider filter to the user service', async () => {
    mockIdempotentUserService.listSessions.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
    });

    await orchestrator.listSessions({ authProvider: 'GOOGLE' });

    expect(mockIdempotentUserService.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ authProvider: 'GOOGLE' }),
    );
  });

  it('passes date range filters to the user service', async () => {
    const dateFrom = new Date('2026-01-01T00:00:00.000Z');
    const dateTo = new Date('2026-01-31T23:59:59.000Z');

    mockIdempotentUserService.listSessions.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
    });

    await orchestrator.listSessions({ dateFrom, dateTo });

    expect(mockIdempotentUserService.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom, dateTo }),
    );
  });

  it('returns empty data when no sessions match filters', async () => {
    mockIdempotentUserService.listSessions.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
    });

    const result = await orchestrator.listSessions({
      status: UserStatus.SUSPENDED,
    });

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});
