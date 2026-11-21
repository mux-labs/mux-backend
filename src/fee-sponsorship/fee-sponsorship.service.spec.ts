import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FeeSponsorshipService } from './fee-sponsorship.service';
import {
  FeeSponsorshipBudgetStatus,
  FeeSponsorshipNetwork,
  SponsorshipActor,
} from './domain/fee-sponsorship-budget.model';
import { FeeSponsorshipErrorCode } from './fee-sponsorship-error-codes';
import { CreateFeeSponsorshipBudgetDto } from './dto/create-fee-sponsorship-budget.dto';

/**
 * Regression tests for FeeSponsorshipService.createBudget.
 *
 * These assert the invariants documented on createBudget:
 * - Caller must be the wallet owner or an authorized delegate/guardian.
 * - A wallet may have at most one active budget per network.
 * - Mainnet writes require the FEE_SPONSORSHIP_ENABLED flag.
 * - Idempotent under concurrent/replayed requests.
 * - Fail-closed on dependency outages.
 */
describe('FeeSponsorshipService.createBudget', () => {
  const walletId = 'wallet-1';
  const sponsorId = 'sponsor-1';

  let prisma: any;
  let metrics: { incrementCounter: jest.Mock };
  let service: FeeSponsorshipService;

  const ownerActor: SponsorshipActor = {
    actorId: walletId,
    correlationId: 'corr-1',
  } as SponsorshipActor;

  const baseDto = (
    overrides: Partial<CreateFeeSponsorshipBudgetDto> = {},
  ): CreateFeeSponsorshipBudgetDto =>
    ({
      walletId,
      sponsorId,
      limitAmount: '1000000',
      network: FeeSponsorshipNetwork.TESTNET,
      ...overrides,
    }) as CreateFeeSponsorshipBudgetDto;

  const storedBudget = (overrides: Record<string, unknown> = {}) => ({
    id: 'budget-1',
    walletId,
    sponsorId,
    limitAmount: '1000000',
    remainingAmount: '1000000',
    assetCode: null,
    assetIssuer: null,
    network: FeeSponsorshipNetwork.TESTNET,
    status: FeeSponsorshipBudgetStatus.ACTIVE,
    note: null,
    idempotencyKey: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  });

  beforeEach(() => {
    delete process.env.FEE_SPONSORSHIP_ENABLED;
    prisma = {
      feeSponsorshipBudget: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(storedBudget()),
      },
    };
    metrics = { incrementCounter: jest.fn() };
    service = new FeeSponsorshipService(prisma as any, metrics as any);
  });

  afterEach(() => {
    delete process.env.FEE_SPONSORSHIP_ENABLED;
  });

  it('creates an active budget for the wallet owner', async () => {
    const result = await service.createBudget(baseDto(), ownerActor);

    expect(prisma.feeSponsorshipBudget.create).toHaveBeenCalledTimes(1);
    const data = prisma.feeSponsorshipBudget.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      walletId,
      sponsorId,
      limitAmount: '1000000',
      remainingAmount: '1000000',
      network: FeeSponsorshipNetwork.TESTNET,
      status: FeeSponsorshipBudgetStatus.ACTIVE,
    });
    expect(result.id).toBe('budget-1');
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'fee_sponsorship.budget_created',
      1,
    );
  });

  it('rejects a caller who is not the wallet owner or an authorized delegate', async () => {
    const stranger: SponsorshipActor = {
      actorId: 'someone-else',
      correlationId: 'corr-2',
    } as SponsorshipActor;

    await expect(service.createBudget(baseDto(), stranger)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.feeSponsorshipBudget.create).not.toHaveBeenCalled();
  });

  it('denies mainnet writes when FEE_SPONSORSHIP_ENABLED is not set', async () => {
    await expect(
      service.createBudget(
        baseDto({ network: FeeSponsorshipNetwork.MAINNET }),
        ownerActor,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: FeeSponsorshipErrorCode.FEATURE_FLAG_DISABLED,
      }),
    });
    expect(prisma.feeSponsorshipBudget.create).not.toHaveBeenCalled();
  });

  it('allows mainnet writes when FEE_SPONSORSHIP_ENABLED is truthy', async () => {
    process.env.FEE_SPONSORSHIP_ENABLED = 'true';
    prisma.feeSponsorshipBudget.create.mockResolvedValue(
      storedBudget({ network: FeeSponsorshipNetwork.MAINNET }),
    );

    const result = await service.createBudget(
      baseDto({ network: FeeSponsorshipNetwork.MAINNET }),
      ownerActor,
    );

    expect(prisma.feeSponsorshipBudget.create).toHaveBeenCalledTimes(1);
    expect(result.network).toBe(FeeSponsorshipNetwork.MAINNET);
  });

  it('rejects a second active budget for the same wallet and network', async () => {
    prisma.feeSponsorshipBudget.findFirst.mockResolvedValue(storedBudget());

    await expect(service.createBudget(baseDto(), ownerActor)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: FeeSponsorshipErrorCode.BUDGET_ALREADY_EXISTS,
      }),
    });
    expect(prisma.feeSponsorshipBudget.create).not.toHaveBeenCalled();
  });

  it('returns the stored budget on a replayed idempotency key', async () => {
    const replayed = storedBudget({ id: 'budget-replay', idempotencyKey: 'key-1' });
    prisma.feeSponsorshipBudget.findFirst.mockResolvedValue(replayed);

    const result = await service.createBudget(
      baseDto({ idempotencyKey: 'key-1' }),
      ownerActor,
    );

    expect(result.id).toBe('budget-replay');
    expect(prisma.feeSponsorshipBudget.create).not.toHaveBeenCalled();
  });

  it('resolves a concurrent create race to the winner when the key matches', async () => {
    const winner = storedBudget({ id: 'budget-winner', idempotencyKey: 'key-1' });
    // First findFirst (active check) misses; the replay lookup after the race finds the winner.
    prisma.feeSponsorshipBudget.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    prisma.feeSponsorshipBudget.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    const result = await service.createBudget(
      baseDto({ idempotencyKey: 'key-1' }),
      ownerActor,
    );

    expect(result.id).toBe('budget-winner');
  });

  it('fails closed with 503 when the store is unavailable', async () => {
    prisma.feeSponsorshipBudget.findFirst.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'P1001' }),
    );

    await expect(service.createBudget(baseDto(), ownerActor)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.feeSponsorshipBudget.create).not.toHaveBeenCalled();
  });
});

/**
 * Regression tests for FeeSponsorshipService.enforceAuthorization.
 *
 * These assert the invariants documented on enforceAuthorization:
 * - Deny-by-default: only the wallet owner or an authorized delegate/guardian
 *   may manage fee sponsorship budgets.
 * - When sponsorId is given, the authenticated actor must be that sponsor.
 * - The actor is never taken from the request body.
 */
describe('FeeSponsorshipService.enforceAuthorization', () => {
  const walletId = 'wallet-1';
  const sponsorId = 'sponsor-1';

  let prisma: any;
  let metrics: { incrementCounter: jest.Mock };
  let service: FeeSponsorshipService;

  const actor = (actorId: string): SponsorshipActor =>
    ({ actorId, correlationId: 'corr-auth' }) as SponsorshipActor;

  beforeEach(() => {
    prisma = {
      feeSponsorshipBudget: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    metrics = { incrementCounter: jest.fn() };
    service = new FeeSponsorshipService(prisma as any, metrics as any);
  });

  it('authorizes the wallet owner', () => {
    expect(() =>
      (service as any).enforceAuthorization(walletId, actor(walletId)),
    ).not.toThrow();
  });

  it('authorizes an authorized delegate/guardian of the wallet', () => {
    const delegate = actor('delegate-1');
    jest
      .spyOn(service as any, 'isAuthorizedDelegate')
      .mockReturnValue(true);

    expect(() =>
      (service as any).enforceAuthorization(walletId, delegate),
    ).not.toThrow();
  });

  it('denies an unauthorized actor by default', () => {
    jest
      .spyOn(service as any, 'isAuthorizedDelegate')
      .mockReturnValue(false);

    expect(() =>
      (service as any).enforceAuthorization(walletId, actor('stranger')),
    ).toThrow(ForbiddenException);
  });

  it('requires the actor to be the sponsor when sponsorId is given', () => {
    expect(() =>
      (service as any).enforceAuthorization(walletId, actor('not-the-sponsor'), sponsorId),
    ).toThrow(ForbiddenException);

    expect(() =>
      (service as any).enforceAuthorization(walletId, actor(sponsorId), sponsorId),
    ).not.toThrow();
  });
});
