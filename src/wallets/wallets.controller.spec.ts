import { Test, TestingModule } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletNetwork } from './domain/wallet.model';

// Mock guards to avoid dependency resolution issues
class MockApiKeyGuard {
  canActivate() { return true; }
}
class MockRateLimitGuard {
  canActivate() { return true; }
}

describe('WalletsController', () => {
  let controller: WalletsController;
  let walletsService: WalletsService;

  const mockWalletsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    getWalletStatus: jest.fn(),
    activateWallet: jest.fn(),
    findWalletsByUserId: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        {
          provide: WalletsService,
          useValue: mockWalletsService,
        },
        {
          provide: APP_GUARD,
          useClass: MockApiKeyGuard,
        },
      ],
    }).compile();

    controller = module.get<WalletsController>(WalletsController);
    walletsService = module.get<WalletsService>(WalletsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call create on the wallets service', async () => {
    const dto: CreateWalletDto = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
    };

    mockWalletsService.create.mockResolvedValue({ wallet: { id: 'wallet-123' }, privateKey: 'secret' });

    await expect(controller.create(dto)).resolves.toEqual({
      wallet: { id: 'wallet-123' },
      privateKey: 'secret',
    });
    expect(mockWalletsService.create).toHaveBeenCalledWith(dto);
  });

  it('should call findOne with the requested wallet id', async () => {
    mockWalletsService.findOne.mockResolvedValue({ id: 'wallet-123' });

    await expect(controller.findOne('wallet-123')).resolves.toEqual({ id: 'wallet-123' });
    expect(mockWalletsService.findOne).toHaveBeenCalledWith('wallet-123');
  });

  // #185: Wallet Status Endpoint
  describe('getWalletStatus', () => {
    it('should return wallet status by id', async () => {
      const statusResponse = {
        id: 'wallet-123',
        status: 'ACTIVE',
        statusReason: null,
        statusChangedAt: new Date(),
        network: 'TESTNET',
        publicKey: 'GABC123',
        userId: 'user-123',
        updatedAt: new Date(),
      };

      mockWalletsService.getWalletStatus.mockResolvedValue(statusResponse);

      await expect(controller.getWalletStatus('wallet-123')).resolves.toEqual(
        statusResponse,
      );
      expect(mockWalletsService.getWalletStatus).toHaveBeenCalledWith(
        'wallet-123',
      );
    });
  });

  // #188: Activate Wallet
  describe('activateWallet', () => {
    it('should activate a wallet', async () => {
      const activatedWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        status: 'ACTIVE',
        network: 'TESTNET',
      };

      mockWalletsService.activateWallet.mockResolvedValue(activatedWallet);

      await expect(controller.activateWallet('wallet-123')).resolves.toEqual(
        activatedWallet,
      );
      expect(mockWalletsService.activateWallet).toHaveBeenCalledWith(
        'wallet-123',
      );
    });
  });

  // #189: List wallets by userId
  describe('findByUserId', () => {
    it('should return wallets for a userId', async () => {
      const wallets = [
        { id: 'wallet-1', userId: 'user-123', network: 'TESTNET' },
        { id: 'wallet-2', userId: 'user-123', network: 'MAINNET' },
      ];

      mockWalletsService.findWalletsByUserId.mockResolvedValue(wallets);

      await expect(controller.findByUserId('user-123')).resolves.toEqual(
        wallets,
      );
      expect(mockWalletsService.findWalletsByUserId).toHaveBeenCalledWith(
        'user-123',
      );
    });
  });
});
