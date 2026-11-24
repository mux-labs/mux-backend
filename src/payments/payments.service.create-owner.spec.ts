import { NotFoundException } from '@nestjs/common';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { PaymentsService } from './payments.service';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import type { PrismaService } from '../prisma/prisma.service';
import type { LimitsService } from '../limits/limits.service';
import type { WalletsService } from '../wallets/wallets.service';

/**
 * `payments.service.ts` imports `./entities/payment.entity`, which is not
 * present in the tree; a virtual stub with the statuses the service uses lets
 * the service load. The DI collaborators are stubbed so this suite only
 * exercises `create`.
 */
jest.mock(
  './entities/payment.entity',
  () => ({
    PaymentStatus: {
      PENDING: 'PENDING',
      CONFIRMED: 'CONFIRMED',
      FAILED: 'FAILED',
    },
  }),
  { virtual: true },
);
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../limits/limits.service', () => ({ LimitsService: class {} }));
jest.mock('../wallets/wallets.service', () => ({ WalletsService: class {} }));

/** Hands a jest stub to the service constructor as its declared dependency. */
const asDependency = <T>(stub: unknown): T => stub as T;

/** The `data` payload handed to `prisma.payment.create`. */
type PaymentCreateArgs = { data: Record<string, unknown> };

/**
 * Regression tests for `PaymentsService.create` (#1343, #1112).
 *
 * Documented contract: `developerOwnerId` is supplied by the controller from
 * the API key context, never from the request body. It is required so
 * ownership can never be claimed by a caller.
 */
describe('PaymentsService.create ownership (#1343)', () => {
  const VICTIM = 'dev-victim';
  const ATTACKER = 'dev-attacker';
  const SENDER_WALLET_ID = '11111111-1111-1111-1111-111111111111';
  const RECEIVER_WALLET_ID = '22222222-2222-2222-2222-222222222222';

  const originalIsolation = process.env.PAYMENT_ISOLATION_ENABLED;

  let prisma: {
    payment: {
      findUnique: jest.Mock;
      create: jest.Mock<Promise<unknown>, [PaymentCreateArgs]>;
    };
  };
  let limits: { checkLimits: jest.Mock };
  let wallets: { findWalletById: jest.Mock };
  let service: PaymentsService;

  /** Wallets keyed by id; the sender wallet belongs to `senderOwner`. */
  const stubWallets = (senderOwner: string) => {
    wallets.findWalletById.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        userId: id === SENDER_WALLET_ID ? senderOwner : 'someone-else',
        status: WalletStatus.ACTIVE,
      }),
    );
  };

  /** A request body, optionally smuggling a `developerOwnerId` claim. */
  const body = (extra: Record<string, unknown> = {}) =>
    ({
      walletId: SENDER_WALLET_ID,
      receiverWalletId: RECEIVER_WALLET_ID,
      fromId: 1,
      toId: 2,
      amount: '10.0000000',
      currency: 'XLM',
      ...extra,
    }) as unknown as CreatePaymentDto;

  beforeEach(() => {
    // Unset → isolation defaults ON (fail closed).
    delete process.env.PAYMENT_ISOLATION_ENABLED;

    prisma = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: PaymentCreateArgs) =>
          Promise.resolve({ id: 'payment-1', ...data } as unknown),
        ),
      },
    };
    limits = { checkLimits: jest.fn().mockResolvedValue(undefined) };
    wallets = { findWalletById: jest.fn() };

    service = new PaymentsService(
      asDependency<PrismaService>(prisma),
      asDependency<LimitsService>(limits),
      asDependency<WalletsService>(wallets),
    );
  });

  afterAll(() => {
    if (originalIsolation === undefined) {
      delete process.env.PAYMENT_ISOLATION_ENABLED;
    } else {
      process.env.PAYMENT_ISOLATION_ENABLED = originalIsolation;
    }
  });

  it('stamps the row with the controller-supplied owner, ignoring a body claim', async () => {
    stubWallets(VICTIM);

    await service.create(body({ developerOwnerId: ATTACKER }), VICTIM);

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    const [{ data }] = prisma.payment.create.mock.calls[0];
    expect(data.developerOwnerId).toBe(VICTIM);
  });

  it('refuses a caller who claims the wallet owner in the body (404, nothing written)', async () => {
    // The sender wallet belongs to VICTIM. The authenticated caller is
    // ATTACKER, who tries to claim VICTIM's ownership via the body.
    stubWallets(VICTIM);

    await expect(
      service.create(body({ developerOwnerId: VICTIM }), ATTACKER),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(limits.checkLimits).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('does not replay another developer’s idempotent payment when the body claims that owner', async () => {
    prisma.payment.findUnique.mockResolvedValue({
      id: 'payment-victim',
      idempotencyKey: 'key-1',
      developerOwnerId: VICTIM,
    });

    await expect(
      service.create(
        body({ idempotencyKey: 'key-1', developerOwnerId: VICTIM }),
        ATTACKER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(wallets.findWalletById).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('replays the cached payment for the controller-supplied owner', async () => {
    const existing = {
      id: 'payment-victim',
      idempotencyKey: 'key-1',
      developerOwnerId: VICTIM,
    };
    prisma.payment.findUnique.mockResolvedValue(existing);

    await expect(
      service.create(
        body({ idempotencyKey: 'key-1', developerOwnerId: ATTACKER }),
        VICTIM,
      ),
    ).resolves.toBe(existing);

    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});
