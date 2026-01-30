import { Test, TestingModule } from '@nestjs/testing';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { WalletCreationOrchestrator } from '../wallets/wallet-creation-orchestrator.service';
import { WalletNetwork } from '../wallets/domain/wallet.model';

describe('AuthOrchestrator', () => {
  let service: AuthOrchestrator;
  let idempotentUserService: jest.Mocked<IdempotentUserService>;
  let walletCreationOrchestrator: jest.Mocked<WalletCreationOrchestrator>;

  const mockIdempotentUserService = {
    findOrCreateUser: jest.fn(),
    findUserByAuthId: jest.fn(),
  };

  const mockWalletCreationOrchestrator = {
    getWalletByUser: jest.fn(),
    createWallet: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthOrchestrator,
        {
          provide: IdempotentUserService,
          useValue: mockIdempotentUserService,
        },
        {
          provide: WalletCreationOrchestrator,
          useValue: mockWalletCreationOrchestrator,
        },
      ],
    }).compile();

    service = module.get<AuthOrchestrator>(AuthOrchestrator);
    idempotentUserService = module.get(IdempotentUserService);
    walletCreationOrchestrator = module.get(WalletCreationOrchestrator);

    jest.clearAllMocks();
  });

  describe('handleAuthentication', () => {
    const authRequest = {
      authId: 'auth-123',
      email: 'test@example.com',
      displayName: 'Test User',
      authProvider: 'GOOGLE',
    };

    it('should create both user and wallet for first-time authentication', async () => {
      // Arrange
      const mockUser = {
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'encrypted',
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        secretVersion: 1,
        statusChangedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockIdempotentUserService.findOrCreateUser.mockResolvedValue({
        user: mockUser,
        isNewUser: true,
      });

      mockWalletCreationOrchestrator.getWalletByUser.mockResolvedValue(null);
      mockWalletCreationOrchestrator.createWallet.mockResolvedValue({
        wallet: mockWallet,
        privateKey: 'secret',
        isNewWallet: true,
      });

      // Act
      const result = await service.handleAuthentication(authRequest);

      // Assert
      expect(result.isNewUser).toBe(true);
      expect(result.isNewWallet).toBe(true);
      expect(result.user.id).toBe('user-123');
      expect(result.wallet.id).toBe('wallet-123');
      expect(idempotentUserService.findOrCreateUser).toHaveBeenCalledWith({
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        authProvider: 'GOOGLE',
      });
      expect(walletCreationOrchestrator.createWallet).toHaveBeenCalled();
    });

    it('should return existing user and wallet for returning authentication', async () => {
      // Arrange
      const mockUser = {
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'encrypted',
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        secretVersion: 1,
        statusChangedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockIdempotentUserService.findOrCreateUser.mockResolvedValue({
        user: mockUser,
        isNewUser: false,
      });

      mockWalletCreationOrchestrator.getWalletByUser.mockResolvedValue(
        mockWallet,
      );

      // Act
      const result = await service.handleAuthentication(authRequest);

      // Assert
      expect(result.isNewUser).toBe(false);
      expect(result.isNewWallet).toBe(false);
      expect(result.user.id).toBe('user-123');
      expect(result.wallet.id).toBe('wallet-123');
      expect(walletCreationOrchestrator.createWallet).not.toHaveBeenCalled();
    });

    it('should create wallet for existing user without wallet', async () => {
      // Arrange
      const mockUser = {
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'encrypted',
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        secretVersion: 1,
        statusChangedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockIdempotentUserService.findOrCreateUser.mockResolvedValue({
        user: mockUser,
        isNewUser: false,
      });

      mockWalletCreationOrchestrator.getWalletByUser.mockResolvedValue(null);
      mockWalletCreationOrchestrator.createWallet.mockResolvedValue({
        wallet: mockWallet,
        privateKey: 'secret',
        isNewWallet: true,
      });

      // Act
      const result = await service.handleAuthentication(authRequest);

      // Assert
      expect(result.isNewUser).toBe(false);
      expect(result.isNewWallet).toBe(true);
      expect(walletCreationOrchestrator.createWallet).toHaveBeenCalled();
    });
  });

  describe('validateAuthentication', () => {
    it('should return true for valid authId', async () => {
      // Arrange
      mockIdempotentUserService.findUserByAuthId.mockResolvedValue({
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Act
      const result = await service.validateAuthentication('auth-123');

      // Assert
      expect(result).toBe(true);
    });

    it('should return true for new users', async () => {
      // Arrange
      mockIdempotentUserService.findUserByAuthId.mockResolvedValue(null);

      // Act
      const result = await service.validateAuthentication('new-auth-id');

      // Assert
      expect(result).toBe(true);
    });
  });
});
