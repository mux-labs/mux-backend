// Avoid the ESM-only dependency of @stellar/stellar-sdk v17 in Jest; the
// declared CJS stellar-sdk exposes the same Keypair API used by this service.
jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: jest.requireActual('stellar-sdk').Keypair,
}));

import { WalletsService } from './wallets.service';

/**
 * Regression coverage for findAll (#1321): with a developerId the listing is
 * scoped through the developer's projects (and fails closed when there are
 * none); without one it is the internal/admin full list.
 */
describe('WalletsService.findAll', () => {
  const walletRecord = (id: string) => ({
    id,
    userId: `user-${id}`,
    publicKey: `GPUBLIC${id}`,
    network: 'TESTNET',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  });

  const buildService = () => {
    const prisma = {
      project: { findMany: jest.fn() },
      apiKeyUsage: { findMany: jest.fn() },
      apiKey: { findMany: jest.fn() },
      wallet: { findMany: jest.fn() },
    };
    const service = new WalletsService({} as any, {} as any, {} as any);
    (service as any).prisma = prisma;
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
    return { service, prisma };
  };

  it('returns the full list for internal/admin use when no developerId is given', async () => {
    const { service, prisma } = buildService();
    const records = [walletRecord('1'), walletRecord('2')];
    prisma.wallet.findMany.mockResolvedValue(records);

    const result = await service.findAll();

    expect(prisma.wallet.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.project.findMany).not.toHaveBeenCalled();
    expect(result).toEqual(
      records.map((w) => expect.objectContaining({ id: w.id, userId: w.userId })),
    );
  });

  it('fails closed with an empty list when the developer owns no projects', async () => {
    const { service, prisma } = buildService();
    prisma.project.findMany.mockResolvedValue([]);

    await expect(service.findAll({ developerId: 'dev-1' })).resolves.toEqual([]);

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { developerId: 'dev-1' },
      select: { id: true },
    });
    expect(prisma.wallet.findMany).not.toHaveBeenCalled();
  });

  it('scopes the lookup through the developer’s projects when a developerId is given', async () => {
    const { service, prisma } = buildService();
    prisma.project.findMany.mockResolvedValue([{ id: 'project-1' }]);
    prisma.apiKeyUsage.findMany
      .mockResolvedValueOnce([{ apiKeyId: 'key-1' }])
      .mockResolvedValueOnce([{ endpoint: '/auth/login' }]);
    prisma.apiKey.findMany.mockResolvedValue([{ id: 'key-1' }]);
    prisma.wallet.findMany.mockResolvedValue([walletRecord('3')]);

    const result = await service.findAll({ developerId: 'dev-1' });

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { developerId: 'dev-1' },
      select: { id: true },
    });
    expect(prisma.apiKeyUsage.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith({
      where: { projectId: { in: ['project-1'] } },
      select: { id: true },
    });
    expect(result).toEqual([
      expect.objectContaining({ id: '3', userId: 'user-3' }),
    ]);
  });
});
