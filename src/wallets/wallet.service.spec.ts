import { Test } from '@nestjs/testing';
import { StrKey } from 'stellar-sdk';
import { WalletService } from './wallet.service';

describe('WalletService.registerWallet', () => {
  let service: WalletService;
  let prisma: {
    wallet: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
  };

  const ownerId = 'owner-1';
  const validAddress = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));

  beforeEach(async () => {
    prisma = {
      wallet: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: 'PrismaService', useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(WalletService);
  });

  it('registers a wallet for the owner', async () => {
    prisma.wallet.findUnique.mockResolvedValue(null);
    prisma.wallet.create.mockResolvedValue({
      id: 'wallet-1',
      address: validAddress,
      ownerId,
    });

    const result = await service.registerWallet(ownerId, {
      address: validAddress,
    });

    expect(prisma.wallet.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ address: validAddress, ownerId });
  });

  it('denies callers that are not the owner', async () => {
    await expect(
      service.registerWallet('someone-else', {
        address: validAddress,
        ownerId,
      } as any),
    ).rejects.toMatchObject({ code: 'WALLET_FORBIDDEN' });

    expect(prisma.wallet.create).not.toHaveBeenCalled();
  });

  it('rejects malformed Stellar addresses before any DB write', async () => {
    await expect(
      service.registerWallet(ownerId, { address: 'not-a-stellar-address' }),
    ).rejects.toMatchObject({ code: 'WALLET_ADDRESS_INVALID' });

    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.wallet.create).not.toHaveBeenCalled();
  });

  it('maps duplicate addresses to WALLET_ADDRESS_ALREADY_EXISTS', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: 'wallet-existing',
      address: validAddress,
      ownerId: 'other-owner',
    });

    await expect(
      service.registerWallet(ownerId, { address: validAddress }),
    ).rejects.toMatchObject({ code: 'WALLET_ADDRESS_ALREADY_EXISTS' });

    expect(prisma.wallet.create).not.toHaveBeenCalled();
  });
});
