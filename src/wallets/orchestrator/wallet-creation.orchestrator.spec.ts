import { Test, TestingModule } from '@nestjs/testing';
import { WalletCreationOrchestrator } from './wallet-creation.orchestrator';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('WalletCreationOrchestrator', () => {
  let orchestrator: WalletCreationOrchestrator;
  let prismaService: any;

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockWallet = {
    id: 'wallet-123',
    userId: 'user-123',
    publicKey: 'GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ',
    encryptedKey: 'encrypted-secret-key',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockPrismaService = {
      $transaction: jest.fn(),
      user: {
        findUnique: jest.fn(),
      },
      wallet: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletCreationOrchestrator,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    orchestrator = module.get<WalletCreationOrchestrator>(WalletCreationOrchestrator);
    prismaService = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(orchestrator).toBeDefined();
  });

  describe('createWallet', () => {
    const createWalletRequest = {
      userId: 'user-123',
      encryptionKey: 'test-encryption-key',
    };

    it('should create a new wallet successfully', async () => {
      const mockTransaction = jest.fn((callback) => {
        return callback(prismaService);
      });

      prismaService.$transaction.mockImplementation(mockTransaction);
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prismaService.wallet.findUnique as jest.Mock).mockResolvedValue(null);
      (prismaService.wallet.create as jest.Mock).mockResolvedValue(mockWallet);

      const result = await orchestrator.createWallet(createWalletRequest);

      expect(result).toEqual({
        walletId: 'wallet-123',
        publicKey: 'GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ',
        userId: 'user-123',
      });

      expect(prismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-123' },
      });

      expect(prismaService.wallet.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      });

      expect(prismaService.wallet.create).toHaveBeenCalled();
    });

    it('should return existing wallet if it already exists (idempotency)', async () => {
      const mockTransaction = jest.fn((callback) => {
        return callback(prismaService);
      });

      prismaService.$transaction.mockImplementation(mockTransaction);
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prismaService.wallet.findUnique as jest.Mock).mockResolvedValue(mockWallet);

      const result = await orchestrator.createWallet(createWalletRequest);

      expect(result).toEqual({
        walletId: 'wallet-123',
        publicKey: 'GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ',
        userId: 'user-123',
      });

      expect(prismaService.wallet.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if user does not exist', async () => {
      const mockTransaction = jest.fn((callback) => {
        return callback(prismaService);
      });

      prismaService.$transaction.mockImplementation(mockTransaction);
      (prismaService.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(orchestrator.createWallet(createWalletRequest)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getWalletByUserId', () => {
    it('should return wallet for existing user', async () => {
      (prismaService.wallet.findUnique as jest.Mock).mockResolvedValue({
        ...mockWallet,
        user: mockUser,
      });

      const result = await orchestrator.getWalletByUserId('user-123');

      expect(result).toEqual({
        ...mockWallet,
        user: mockUser,
      });

      expect(prismaService.wallet.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
        include: { user: true },
      });
    });

    it('should throw NotFoundException if wallet does not exist', async () => {
      (prismaService.wallet.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(orchestrator.getWalletByUserId('user-123')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
