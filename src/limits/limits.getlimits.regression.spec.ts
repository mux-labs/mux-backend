import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LimitsService.getLimits regression (#1308)', () => {
  it('returns persisted limits as strings, or null when no row exists', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        walletId: 'wallet-1',
        dailyLimit: '12.50',
        perTransactionLimit: '3.00',
      });
    const service = new LimitsService();
    // Current service has no constructor injection; bind the Prisma delegate
    // directly so this unit test does not need a database.
    (service as any).prisma = {
      walletLimit: { findUnique },
    } as unknown as PrismaService;

    await expect(service.getLimits('missing')).resolves.toBeNull();
    await expect(service.getLimits('wallet-1')).resolves.toEqual({
      dailyLimit: '12.50',
      perTransactionLimit: '3.00',
    });

    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: { walletId: 'missing' },
    });
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { walletId: 'wallet-1' },
    });
  });
});
