import { Test, TestingModule } from '@nestjs/testing';
import { FeeSponsorshipService } from './fee-sponsorship.service';

describe('FeeSponsorshipService.updateBudget', () => {
  let service: FeeSponsorshipService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FeeSponsorshipService],
    }).compile();

    service = module.get<FeeSponsorshipService>(FeeSponsorshipService);
  });

  it('updates an ACTIVE budget when the caller is the wallet owner', async () => {
    const result = await service.updateBudget({
      budgetId: 'budget-1',
      callerId: 'owner-1',
      walletOwnerId: 'owner-1',
      status: 'ACTIVE',
      amount: 500,
    });

    expect(result).toBeDefined();
    expect(result.amount).toBe(500);
  });

  it('rejects callers who are neither the owner nor an authorized delegate/guardian', async () => {
    await expect(
      service.updateBudget({
        budgetId: 'budget-1',
        callerId: 'stranger-1',
        walletOwnerId: 'owner-1',
        status: 'ACTIVE',
        amount: 500,
      }),
    ).rejects.toThrow();
  });

  it('rejects updates to budgets that are not ACTIVE', async () => {
    await expect(
      service.updateBudget({
        budgetId: 'budget-1',
        callerId: 'owner-1',
        walletOwnerId: 'owner-1',
        status: 'CLOSED',
        amount: 500,
      }),
    ).rejects.toThrow();
  });

  it('does not allow a CLOSED budget to be reopened', async () => {
    await expect(
      service.updateBudget({
        budgetId: 'budget-1',
        callerId: 'owner-1',
        walletOwnerId: 'owner-1',
        status: 'ACTIVE',
        previousStatus: 'CLOSED',
        amount: 500,
      }),
    ).rejects.toThrow();
  });

  it('fails closed when a dependency is unavailable', async () => {
    await expect(
      service.updateBudget({
        budgetId: 'budget-1',
        callerId: 'owner-1',
        walletOwnerId: 'owner-1',
        status: 'ACTIVE',
        amount: 500,
        dependencyUnavailable: true,
      }),
    ).rejects.toThrow();
  });
});

describe('FeeSponsorshipService.findBudgetByIdempotencyKey', () => {
  let service: FeeSponsorshipService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FeeSponsorshipService],
    }).compile();

    service = module.get<FeeSponsorshipService>(FeeSponsorshipService);
  });

  it('returns the budget matching the idempotency key for a wallet+network', async () => {
    const created = await service.createBudget({
      walletId: 'wallet-1',
      network: 'testnet',
      idempotencyKey: 'idem-1',
      amount: 1000,
    });

    const found = await service.findBudgetByIdempotencyKey({
      walletId: 'wallet-1',
      network: 'testnet',
      idempotencyKey: 'idem-1',
    });

    expect(found).toBeDefined();
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.idempotencyKey).toBe('idem-1');
  });

  it('matches regardless of lifecycle status so replays return the stored budget', async () => {
    const created = await service.createBudget({
      walletId: 'wallet-1',
      network: 'testnet',
      idempotencyKey: 'idem-2',
      amount: 1000,
    });

    await service.updateBudget({
      budgetId: created.id,
      callerId: 'owner-1',
      walletOwnerId: 'owner-1',
      status: 'CLOSED',
      amount: 1000,
    });

    const found = await service.findBudgetByIdempotencyKey({
      walletId: 'wallet-1',
      network: 'testnet',
      idempotencyKey: 'idem-2',
    });

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.status).toBe('CLOSED');
  });

  it('returns null when no budget matches the idempotency key', async () => {
    const found = await service.findBudgetByIdempotencyKey({
      walletId: 'wallet-1',
      network: 'testnet',
      idempotencyKey: 'missing-key',
    });

    expect(found).toBeNull();
  });
});
