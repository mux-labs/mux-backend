import { Test, TestingModule } from '@nestjs/testing';
import { REQUIRE_API_KEY } from '../api-keys/api-key.guard';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

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
    })
      .overrideGuard(ApiKeyGuard)
      .useValue(mockApiKeyGuard)
      .overrideGuard(RateLimitGuard)
      .useValue(mockRateLimitGuard)
      .compile();

    controller = module.get<WalletsController>(WalletsController);
    walletsService = module.get<WalletsService>(WalletsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should mark protectedEndpoint with RequireApiKey metadata', () => {
    const metadata = Reflect.getMetadata(
      REQUIRE_API_KEY,
      controller.protectedEndpoint,
    );
    expect(metadata).toBe(true);
  });

  describe('create', () => {
    it('should call walletsService.create with the provided DTO', async () => {
      const createWalletDto = { name: 'Test Wallet' };
      mockWalletsService.create.mockResolvedValue({
        id: 1,
        ...createWalletDto,
      });

      const result = await controller.create(createWalletDto as any);

      expect(walletsService.create).toHaveBeenCalledWith(createWalletDto);
      expect(result).toEqual({ id: 1, ...createWalletDto });
    });
  });

  describe('findAll', () => {
    it('should call walletsService.findAll', async () => {
      const wallets = [{ id: 1, name: 'Wallet 1' }];
      mockWalletsService.findAll.mockResolvedValue(wallets);

      const result = await controller.findAll();

      expect(walletsService.findAll).toHaveBeenCalled();
      expect(result).toEqual(wallets);
    });
  });

  describe('findOne', () => {
    it('should call walletsService.findOne with the provided id', async () => {
      const wallet = { id: 1, name: 'Wallet 1' };
      mockWalletsService.findOne.mockResolvedValue(wallet);

      const result = await controller.findOne('1');

      expect(walletsService.findOne).toHaveBeenCalledWith(1);
      expect(result).toEqual(wallet);
    });
  });

  describe('update', () => {
    it('should call walletsService.update with the provided id and DTO', async () => {
      const updateWalletDto = { name: 'Updated Wallet' };
      const updatedWallet = { id: 1, ...updateWalletDto };
      mockWalletsService.update.mockResolvedValue(updatedWallet);

      const result = await controller.update('1', updateWalletDto as any);

      expect(walletsService.update).toHaveBeenCalledWith(1, updateWalletDto);
      expect(result).toEqual(updatedWallet);
    });
  });

  describe('remove', () => {
    it('should call walletsService.remove with the provided id', async () => {
      mockWalletsService.remove.mockResolvedValue({ id: 1, deleted: true });

      const result = await controller.remove('1');

      expect(walletsService.remove).toHaveBeenCalledWith(1);
      expect(result).toEqual({ id: 1, deleted: true });
    });
  });

  describe('protectedEndpoint', () => {
    it('should return protected endpoint response with context', async () => {
      const mockContext = {
        developer: { email: 'dev@example.com' },
        project: { name: 'Test Project' },
        apiKey: { key: 'test-key' },
      };

      const result = await controller.protectedEndpoint(mockContext as any);

      expect(result).toEqual({
        message: 'This endpoint is protected by API key',
        developer: 'dev@example.com',
        project: 'Test Project',
      });
    });
  });
});
