import { Test, TestingModule } from '@nestjs/testing';
import { REQUIRE_API_KEY } from '../api-keys/api-key.guard';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletNetwork } from './domain/wallet.model';

const mockWalletsService = {
  create: jest.fn(),
  findOne: jest.fn(),
};

describe('WalletsController', () => {
  let controller: WalletsController;
  let walletsService: WalletsService;

  const mockWalletsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  const mockApiKeyGuard = {
    canActivate: jest.fn(() => true),
  };

  const mockRateLimitGuard = {
    canActivate: jest.fn(() => true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        {
          provide: WalletsService,
          useValue: mockWalletsService,
        },
      ],
    }).compile();

    controller = module.get<WalletsController>(WalletsController);
    walletsService = module.get<WalletsService>(WalletsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
});
