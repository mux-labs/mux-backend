        update: jest.fn(),
      },
    };

  const wallet = (overrides: Record<string, unknown> = {}) => ({
    id: walletId,
    ownerId,
    successorId: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      wallet: {
        findUnique: jest.fn(),
        update: jest.fn(),
  beforeEach(async () => {
    prisma = {
      wallet: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

  const wallet = (overrides: Record<string, unknown> = {}) => ({
    id: walletId,
    ownerId,
    successorId: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      wallet: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(WalletService);
  });

  it('sets the successor when the caller is the owner', async () => {
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet())
      .mockResolvedValueOnce(wallet({ id: successorId }));
    prisma.wallet.update.mockResolvedValue(
      wallet({ successorId }),
    );

    await service.setSuccessor(walletId, successorId, ownerId);

    expect(prisma.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: walletId },
        data: { successorId },
      }),
    );
  });

  it('clears the successor when successorId is null', async () => {
    prisma.wallet.findUnique.mockResolvedValueOnce(
      wallet({ successorId }),
    );
    prisma.wallet.update.mockResolvedValue(wallet());

    await service.setSuccessor(walletId, null, ownerId);

    expect(prisma.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: walletId },
        data: expect.objectContaining({ successor_id: 'successor-1' }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ successor_id: 'successor-1' }),
    );
  });

  it('allows an explicitly authorized delegate to mutate successor_id', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: walletId,
      owner_id: ownerId,
      delegates: [{ actor_id: delegateId }],
      guardians: [],
    });
    prisma.wallet.update.mockResolvedValue({
      id: walletId,
      successor_id: 'successor-2',
    });

    await expect(
      service.caller(
        { id: delegateId } as any,
        walletId,
        { successor_id: 'successor-2' } as any,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ successor_id: 'successor-2' }),
    );
  });

  it('denies an unauthorized actor by default (failure path)', async () => {
    prisma.wallet.findUnique.mockResolvedValue({
      id: walletId,
      owner_id: ownerId,
      delegates: [],
      guardians: [],
    });

    await expect(
      service.caller(
        { id: strangerId } as any,
        walletId,
        { successor_id: 'successor-3' } as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });
});
