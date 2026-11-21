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

describe('KeyRotationService.assertReadAuthorized', () => {
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
      service.assertReadAuthorized('wallet-1', {
        userId: 'owner-1',
        role: 'owner',
      }),
    ).resolves.toBeUndefined();

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
    });
  });

  it('allows a delegate principal to read', async () => {
    const { service } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
      delegates: [{ userId: 'delegate-1' }],
    });

    await expect(
      service.assertReadAuthorized('wallet-1', {
        userId: 'delegate-1',
        role: 'delegate',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows a guardian principal to read', async () => {
    const { service } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
      guardians: [{ userId: 'guardian-1' }],
    });

    await expect(
      service.assertReadAuthorized('wallet-1', {
        userId: 'guardian-1',
        role: 'guardian',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows an API-key principal to read', async () => {
    const { service } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
    });

    await expect(
      service.assertReadAuthorized('wallet-1', {
        apiKeyId: 'api-key-1',
        role: 'api-key',
      }),
    ).resolves.toBeUndefined();
  });

  it('allows a JWT principal to read', async () => {
    const { service } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
    });

    await expect(
      service.assertReadAuthorized('wallet-1', {
        userId: 'jwt-user-1',
        role: 'jwt',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a caller claiming owner for a wallet they do not own', async () => {
    const { service } = buildService({
      id: 'wallet-1',
      userId: 'owner-1',
    });

    await expect(
      service.assertReadAuthorized('wallet-1', {
        userId: 'intruder-1',
        role: 'owner',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses when the wallet does not exist', async () => {
    const { service } = buildService(null);

    await expect(
      service.assertReadAuthorized('missing-wallet', {
        userId: 'owner-1',
        role: 'owner',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
