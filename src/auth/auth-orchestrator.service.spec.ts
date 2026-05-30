import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AuthOrchestrator, AuthPayloadValidator } from './auth-orchestrator.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { WalletCreationOrchestrator } from '../wallets/wallet-creation-orchestrator.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { WalletNetwork } from '../wallets/domain/wallet.model';

describe('AuthPayloadValidator', () => {
  describe('validate', () => {
    it('should pass validation for valid payload', () => {
      const validPayload = {
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        authProvider: 'CLERK',
      };

      expect(() => AuthPayloadValidator.validate(validPayload)).not.toThrow();
    });

    it('should pass validation for minimal payload with only authId', () => {
      const minimalPayload = {
        authId: 'auth-123',
      };

      expect(() => AuthPayloadValidator.validate(minimalPayload)).not.toThrow();
    });

    it('should throw BadRequestException when payload is null', () => {
      expect(() => AuthPayloadValidator.validate(null)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when payload is not an object', () => {
      expect(() => AuthPayloadValidator.validate('invalid')).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when authId is missing', () => {
      const invalidPayload = {
        email: 'test@example.com',
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when authId is empty', () => {
      const invalidPayload = {
        authId: '   ',
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when authId is not a string', () => {
      const invalidPayload = {
        authId: 123,
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when email format is invalid', () => {
      const invalidPayload = {
        authId: 'auth-123',
        email: 'invalid-email',
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should pass validation when email is empty string', () => {
      const payload = {
        authId: 'auth-123',
        email: '',
      };

      expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    });

    it('should throw BadRequestException when email is not a string', () => {
      const invalidPayload = {
        authId: 'auth-123',
        email: 123,
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when displayName is empty', () => {
      const invalidPayload = {
        authId: 'auth-123',
        displayName: '   ',
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when displayName is not a string', () => {
      const invalidPayload = {
        authId: 'auth-123',
        displayName: 123,
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when authProvider is not a string', () => {
      const invalidPayload = {
        authId: 'auth-123',
        authProvider: 123,
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when network is invalid', () => {
      const invalidPayload = {
        authId: 'auth-123',
        network: 'INVALID_NETWORK',
      };

      expect(() => AuthPayloadValidator.validate(invalidPayload)).toThrow(
        BadRequestException,
      );
    });

    it('should pass validation with valid network', () => {
      const payload = {
        authId: 'auth-123',
        network: WalletNetwork.TESTNET,
      };

      expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    });
  });
});

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

  const mockIdempotencyService = {
    getCachedResponse: jest.fn(),
    cacheResponse: jest.fn(),
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
        {
          provide: IdempotencyService,
          useValue: mockIdempotencyService,
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

    it('should throw BadRequestException for invalid payload', async () => {
      const invalidRequest = {
        authId: '',
        email: 'test@example.com',
      };

      await expect(service.handleAuthentication(invalidRequest)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when authId is missing', async () => {
      const invalidRequest = {
        email: 'test@example.com',
      } as any;

      await expect(service.handleAuthentication(invalidRequest)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return cached response when idempotency key is provided and cache hit occurs', async () => {
      // Arrange
      const idempotencyKey = 'idempotent-key-123';
      const requestWithIdempotency = {
        ...authRequest,
        idempotencyKey,
      };

      const cachedResponse = {
        user: {
          id: 'user-123',
          authId: 'auth-123',
          email: 'test@example.com',
          displayName: 'Test User',
          status: 'ACTIVE',
          authProvider: 'GOOGLE',
        },
        wallet: {
          id: 'wallet-123',
          publicKey: 'GABC123',
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
        },
        isNewUser: false,
        isNewWallet: false,
      };

      mockIdempotencyService.getCachedResponse.mockResolvedValue(cachedResponse);

      // Act
      const result = await service.handleAuthentication(requestWithIdempotency);

      // Assert
      expect(result._idempotencyReplayed).toBe(true);
      expect(mockIdempotencyService.getCachedResponse).toHaveBeenCalledWith(
        idempotencyKey,
      );
      expect(mockIdempotentUserService.findOrCreateUser).not.toHaveBeenCalled();
    });

    it('should cache response when idempotency key is provided', async () => {
      // Arrange
      const idempotencyKey = 'idempotent-key-123';
      const requestWithIdempotency = {
        ...authRequest,
        idempotencyKey,
      };

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

      mockIdempotencyService.getCachedResponse.mockResolvedValue(null);
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
      const result = await service.handleAuthentication(requestWithIdempotency);

      // Assert
      expect(result._idempotencyReplayed).toBe(false);
      expect(mockIdempotencyService.cacheResponse).toHaveBeenCalledWith(
        idempotencyKey,
        expect.objectContaining({
          isNewUser: true,
          isNewWallet: true,
        }),
        'POST',
        '/auth/authenticate',
        200,
        { ttlMs: 60000 },
      );
    });

    it('should process request normally without idempotency key', async () => {
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
      expect(result._idempotencyReplayed).toBe(false);
      expect(mockIdempotencyService.getCachedResponse).not.toHaveBeenCalled();
      expect(mockIdempotencyService.cacheResponse).not.toHaveBeenCalled();
    });

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
