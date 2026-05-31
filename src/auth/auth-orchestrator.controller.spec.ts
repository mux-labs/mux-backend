import { Test, TestingModule } from '@nestjs/testing';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import {
  AuthOrchestrator,
  AuthenticationRequest,
  AuthenticationResult,
} from './auth-orchestrator.service';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';

describe('AuthOrchestratorController', () => {
  let controller: AuthOrchestratorController;
  let authOrchestrator: AuthOrchestrator;
  let reflector: Reflector;

  const mockAuthenticationResult: AuthenticationResult = {
    user: {
      id: 'user-123',
      authId: 'auth-456',
      email: 'test@example.com',
      displayName: 'Test User',
      status: 'ACTIVE',
      authProvider: 'CLERK',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    wallet: {
      id: 'wallet-789',
      userId: 'user-123',
      publicKey: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      network: 'TESTNET',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    isNewUser: false,
    isNewWallet: false,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthOrchestratorController],
      providers: [
        {
          provide: AuthOrchestrator,
          useValue: {
            handleAuthentication: jest.fn(),
            validateAuthentication: jest.fn(),
          },
        },
        Reflector,
      ],
    }).compile();

    controller = module.get<AuthOrchestratorController>(
      AuthOrchestratorController,
    );
    authOrchestrator = module.get<AuthOrchestrator>(AuthOrchestrator);
    reflector = module.get<Reflector>(Reflector);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('authenticate', () => {
    const authRequest: AuthenticationRequest = {
      authId: 'auth-456',
      email: 'test@example.com',
      displayName: 'Test User',
      authProvider: 'CLERK',
      network: 'TESTNET',
    };

    it('should call authOrchestrator.handleAuthentication', async () => {
      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(mockAuthenticationResult);

      const result = await controller.authenticate(authRequest);

      expect(authOrchestrator.handleAuthentication).toHaveBeenCalledWith(
        authRequest,
      );
      expect(result).toEqual(mockAuthenticationResult);
    });

    it('should return authentication result with user and wallet', async () => {
      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(mockAuthenticationResult);

      const result = await controller.authenticate(authRequest);

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('wallet');
      expect(result).toHaveProperty('isNewUser');
      expect(result).toHaveProperty('isNewWallet');
    });

    it('should be marked as public endpoint', () => {
      // Get the authenticate method
      const authenticateMethod = controller.authenticate;

      // Check if the @Public() decorator is applied
      const isPublic = Reflect.getMetadata(IS_PUBLIC, authenticateMethod);

      expect(isPublic).toBe(true);
    });

    it('should handle new user authentication', async () => {
      const newUserResult = {
        ...mockAuthenticationResult,
        isNewUser: true,
        isNewWallet: true,
      };

      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(newUserResult);

      const result = await controller.authenticate(authRequest);

      expect(result.isNewUser).toBe(true);
      expect(result.isNewWallet).toBe(true);
    });

    it('should handle returning user authentication', async () => {
      const returningUserResult = {
        ...mockAuthenticationResult,
        isNewUser: false,
        isNewWallet: false,
      };

      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(returningUserResult);

      const result = await controller.authenticate(authRequest);

      expect(result.isNewUser).toBe(false);
      expect(result.isNewWallet).toBe(false);
    });

    it('should handle authentication with minimal request data', async () => {
      const minimalRequest: AuthenticationRequest = {
        authId: 'auth-456',
        authProvider: 'CLERK',
        network: 'TESTNET',
      };

      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(mockAuthenticationResult);

      const result = await controller.authenticate(minimalRequest);

      expect(authOrchestrator.handleAuthentication).toHaveBeenCalledWith(
        minimalRequest,
      );
      expect(result).toBeDefined();
    });

    it('should propagate errors from authOrchestrator', async () => {
      const error = new Error('Authentication failed');
      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockRejectedValue(error);

      await expect(controller.authenticate(authRequest)).rejects.toThrow(
        'Authentication failed',
      );
    });
  });

  describe('validateAuthentication', () => {
    it('should call authOrchestrator.validateAuthentication', async () => {
      jest
        .spyOn(authOrchestrator, 'validateAuthentication')
        .mockResolvedValue(true);

      const result = await controller.validateAuthentication('auth-123');

      expect(authOrchestrator.validateAuthentication).toHaveBeenCalledWith(
        'auth-123',
      );
      expect(result).toEqual({ valid: true });
    });

    it('should return valid: true for valid authId', async () => {
      jest
        .spyOn(authOrchestrator, 'validateAuthentication')
        .mockResolvedValue(true);

      const result = await controller.validateAuthentication('valid-auth-id');

      expect(result.valid).toBe(true);
    });

    it('should return valid: false for invalid authId', async () => {
      jest
        .spyOn(authOrchestrator, 'validateAuthentication')
        .mockResolvedValue(false);

      const result = await controller.validateAuthentication(
        'invalid-auth-id',
      );

      expect(result.valid).toBe(false);
    });

    it('should handle empty authId', async () => {
      jest
        .spyOn(authOrchestrator, 'validateAuthentication')
        .mockResolvedValue(false);

      const result = await controller.validateAuthentication('');

      expect(result.valid).toBe(false);
    });
  });

  describe('Public decorator verification', () => {
    it('should have @Public decorator on authenticate method', () => {
      const metadata = Reflect.getMetadata(
        IS_PUBLIC,
        controller.authenticate,
      );
      expect(metadata).toBe(true);
    });

    it('should not have @Public decorator on validateAuthentication method', () => {
      const metadata = Reflect.getMetadata(
        IS_PUBLIC,
        controller.validateAuthentication,
      );
      expect(metadata).toBeUndefined();
    });
  });
});
