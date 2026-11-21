import { ForbiddenException } from '@nestjs/common';
import { KeyRotationService } from './key-rotation.service';

describe('KeyRotationService.assertRotationAuthorized', () => {
  const buildService = (wallet: any) => {
    const prisma = {
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet),
      },
    };
    const service = new KeyRotationService(prisma as any);
    return { service, prisma };
  };

  it('allows the owner resolved server-side from the stored userId', async () => {
    const { service, prisma } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
    });

    await expect(
      service.assertRotationAuthorized('wallet-1', 'owner-1'),
    ).resolves.toBeUndefined();

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
    });
  });

  it('refuses a caller who is not the stored owner', async () => {
    const { service } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
    });

    await expect(
      service.assertRotationAuthorized('wallet-1', 'intruder-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a delegate outright even when it may read metadata', async () => {
    const { service } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
      delegates: [{ userId: 'delegate-1' }],
    });

    await expect(
      service.assertRotationAuthorized('wallet-1', 'delegate-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the wallet does not exist', async () => {
    const { service } = buildService(null);

    await expect(
      service.assertRotationAuthorized('missing-wallet', 'owner-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
