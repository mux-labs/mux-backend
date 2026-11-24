import { Logger } from '@nestjs/common';

// payments.service.ts imports `./entities/payment.entity`, which is not present
// in the tree. Stub it (virtually) so this focused suite can load the service
// without depending on that unrelated module.
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

// Collaborators are stubbed so findAll is exercised in isolation; only the
// Prisma mock below is consulted.
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../limits/limits.service', () => ({ LimitsService: class {} }));
jest.mock('../wallets/wallets.service', () => ({ WalletsService: class {} }));

import { PaymentsService } from './payments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { LimitsService } from '../limits/limits.service';
import type { WalletsService } from '../wallets/wallets.service';

const ISOLATION_ENV = 'PAYMENT_ISOLATION_ENABLED';

describe('PaymentsService.findAll', () => {
  const originalIsolation = process.env[ISOLATION_ENV];
  const developerOwnerId = 'dev-owner-1';

  let prisma: { payment: { findMany: jest.Mock } };
  let service: PaymentsService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    prisma = { payment: { findMany: jest.fn() } };
    service = new PaymentsService(
      // Needed for tsc; ESLint only sees it as redundant when the generated
      // Prisma client is absent and PrismaService resolves to an error type.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      prisma as unknown as PrismaService,
      {} as LimitsService,
      {} as WalletsService,
    );
  });

  afterEach(() => {
    if (originalIsolation === undefined) {
      delete process.env[ISOLATION_ENV];
    } else {
      process.env[ISOLATION_ENV] = originalIsolation;
    }
    jest.restoreAllMocks();
  });

  describe('with isolation enabled', () => {
    beforeEach(() => {
      process.env[ISOLATION_ENV] = 'true';
    });

    it('scopes the query to the calling developer', async () => {
      const rows = [{ id: 'payment-1', developerOwnerId }];
      prisma.payment.findMany.mockResolvedValue(rows);

      const result: unknown = await service.findAll(developerOwnerId);

      expect(result).toBe(rows);
      expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.payment.findMany).toHaveBeenCalledWith({
        where: { developerOwnerId },
        orderBy: { createdAt: 'desc' },
      });
    });

    it.each([undefined, ''])(
      'returns an empty page and never runs an unscoped query when developerOwnerId is %p',
      async (missingOwner) => {
        prisma.payment.findMany.mockResolvedValue([{ id: 'leaked' }]);

        const result: unknown = await service.findAll(missingOwner);

        expect(result).toEqual([]);
        expect(prisma.payment.findMany).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
      },
    );
  });

  it('fails closed (empty page) when the flag is unset', async () => {
    delete process.env[ISOLATION_ENV];

    const result: unknown = await service.findAll();

    expect(result).toEqual([]);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it('fails closed (empty page) when the flag holds an unrecognised value', async () => {
    process.env[ISOLATION_ENV] = 'maybe';

    const result: unknown = await service.findAll();

    expect(result).toEqual([]);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it('returns all payments on the legacy path only when isolation is disabled', async () => {
    process.env[ISOLATION_ENV] = 'false';
    const rows = [
      { id: 'payment-1', developerOwnerId },
      { id: 'payment-2', developerOwnerId: 'dev-owner-2' },
    ];
    prisma.payment.findMany.mockResolvedValue(rows);

    const result: unknown = await service.findAll();

    expect(result).toBe(rows);
    expect(prisma.payment.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
    });
  });
});
