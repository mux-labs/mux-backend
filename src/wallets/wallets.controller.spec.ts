import { Test, TestingModule } from '@nestjs/testing';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletNetwork } from './domain/wallet.model';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

describe('WalletsController', () => {
  let controller: WalletsController;
  let walletsService: WalletsService;
  let walletCreationOrchestrator: WalletCreationOrchestrator;

  const mockWalletsService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    getWalletStatus: jest.fn(),
    activateWallet: jest.fn(),
    findWalletsByUserId: jest.fn(),
    getNetworkPreference: jest.fn(),
    setNetworkPreference: jest.fn(),
  };

  const mockWalletCreationOrchestrator = {
    createWallet: jest.fn(),
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
          provide: WalletCreationOrchestrator,
          useValue: mockWalletCreationOrchestrator,
        },
      ],
    })
      .overrideGuard(FeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<WalletsController>(WalletsController);
    walletsService = module.get<WalletsService>(WalletsService);
    walletCreationOrchestrator = module.get<WalletCreationOrchestrator>(
      WalletCreationOrchestrator,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call createWallet on the orchestrator and pass idempotency', async () => {
    const dto: CreateWalletDto = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
      idempotencyKey: 'idem-123',
    };

    mockWalletCreationOrchestrator.createWallet.mockResolvedValue({
      wallet: { id: 'wallet-123' },
      privateKey: 'secret',
      isNewWallet: true,
      idempotencyKey: 'idem-123',
    });

    await expect(controller.create(dto, 'req-123')).resolves.toEqual({
      wallet: { id: 'wallet-123' },
      privateKey: 'secret',
      isNewWallet: true,
      idempotencyKey: 'idem-123',
    });
    expect(mockWalletCreationOrchestrator.createWallet).toHaveBeenCalledWith(
      {
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
        idempotencyKey: 'idem-123',
      },
      'req-123',
    );
  });

  it('should call findOne with the requested wallet id', async () => {
    mockWalletsService.findOne.mockResolvedValue({ id: 'wallet-123' });

    await expect(controller.findOne('wallet-123')).resolves.toEqual({
      id: 'wallet-123',
    });
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

  // #325 / #326: pagination + filtering on the wallet list endpoint
  describe('findAll', () => {
    it('passes filters and default-parsed pagination through to the service', async () => {
      const page = {
        data: [
          {
            id: 'wallet-1',
            userId: 'user-123',
            network: WalletNetwork.TESTNET,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
        hasMore: false,
      };
      mockWalletsService.findAll.mockResolvedValue(page);

      await expect(
        controller.findAll(
          'user-123',
          WalletNetwork.TESTNET,
          undefined,
          undefined,
          undefined,
        ),
      ).resolves.toEqual(page);
      expect(mockWalletsService.findAll).toHaveBeenCalledWith({
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
        status: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('parses limit and offset query strings into numbers', async () => {
      mockWalletsService.findAll.mockResolvedValue({
        data: [],
        total: 0,
        limit: 5,
        offset: 10,
        hasMore: false,
      });

      await controller.findAll(undefined, undefined, undefined, '5', '10');

      expect(mockWalletsService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5, offset: 10 }),
      );
    });

    it('throws a 400 for a non-numeric limit', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, 'abc', undefined),
      ).toThrow('limit must be a non-negative integer');
    });

    it('throws a 400 when limit exceeds the max', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, '1000', undefined),
      ).toThrow('limit must not exceed 100');
    });

    it('throws a 400 for a negative offset', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, undefined, '-1'),
      ).toThrow('offset must be a non-negative integer');
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

  describe('getNetworkPreference', () => {
    it('should return the network preference for a userId', async () => {
      const preference = {
        userId: 'user-123',
        defaultNetwork: WalletNetwork.TESTNET,
      };
      mockWalletsService.getNetworkPreference.mockResolvedValue(preference);

      await expect(
        controller.getNetworkPreference('user-123'),
      ).resolves.toEqual(preference);
      expect(mockWalletsService.getNetworkPreference).toHaveBeenCalledWith(
        'user-123',
      );
    });
  });

  describe('setNetworkPreference', () => {
    it('should persist the network preference for a userId', async () => {
      const preference = {
        userId: 'user-123',
        defaultNetwork: WalletNetwork.MAINNET,
      };
      mockWalletsService.setNetworkPreference.mockResolvedValue(preference);

      await expect(
        controller.setNetworkPreference('user-123', {
          network: WalletNetwork.MAINNET,
        }),
      ).resolves.toEqual(preference);
      expect(mockWalletsService.setNetworkPreference).toHaveBeenCalledWith(
        'user-123',
        WalletNetwork.MAINNET,
      );
    });
  });
});
