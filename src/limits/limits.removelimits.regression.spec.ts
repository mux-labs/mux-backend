import { NotFoundException } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LimitsService.removeLimits regression (#1309)', () => {
  it('deletes an existing row and throws NotFoundException when no row exists', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({
        walletId: 'wallet-1',
        dailyLimit: '10.00',
        perTransactionLimit: '2.00',
      })
      .mockResolvedValueOnce(null);
    const deleteMock = jest.fn().mockResolvedValue({});
    const service = new LimitsService();
    // Current service has no constructor injection; bind the Prisma delegate
    // directly so this unit test does not need a database.
    (service as any).prisma = {
      walletLimit: { findUnique, delete: deleteMock },
    } as unknown as PrismaService;

    await expect(service.removeLimits('wallet-1')).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith({
      where: { walletId: 'wallet-1' },
    });

    await expect(service.removeLimits('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // A missing row must not issue a delete: callers distinguish this from success.
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});
