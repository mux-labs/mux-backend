import { Test, TestingModule } from '@nestjs/testing';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import {
  AuthOrchestrator,
  AuthenticationRequest,
  AuthenticationResult,
} from './auth-orchestrator.service';
import { RefreshTokenService } from './refresh-token.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';

describe('AuthOrchestratorController', () => {
  let controller: AuthOrchestratorController;
  let authOrchestrator: AuthOrchestrator;
  let refreshTokenService: RefreshTokenService;
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
        {
          provide: RefreshTokenService,
          useValue: {
            createRefreshToken: jest.fn(),
          },
        },
        Reflector,
      ],
    })
      .overrideGuard(AuthRateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthOrchestratorController>(
      AuthOrchestratorController,
    );
    authOrchestrator = module.get<AuthOrchestrator>(AuthOrchestrator);
    refreshTokenService = module.get<RefreshTokenService>(RefreshTokenService);
    reflector = module.get<Reflector>(Reflector);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  const mockResponse = () => ({
    json: jest.fn(),
    setHeader: jest.fn(),
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
      jest
        .spyOn(refreshTokenService, 'createRefreshToken')
        .mockResolvedValue({ id: 'token-123' } as any);

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await controller.authenticate(authRequest, undefined, mockReq, response as any);

      expect(authOrchestrator.handleAuthentication).toHaveBeenCalledWith({
        ...authRequest,
        idempotencyKey: undefined,
        ipAddress: '127.0.0.1',
        userAgent: 'test',
      });
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: mockAuthenticationResult.user,
          wallet: mockAuthenticationResult.wallet,
          refreshToken: expect.any(String),
        }),
      );
    });

    it('should return authentication result with user, wallet, and refresh token', async () => {
      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(mockAuthenticationResult);
      jest
        .spyOn(refreshTokenService, 'createRefreshToken')
        .mockResolvedValue({ id: 'token-123' } as any);

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await controller.authenticate(authRequest, undefined, mockReq, response as any);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.any(Object),
          wallet: expect.any(Object),
          refreshToken: expect.any(String),
          isNewUser: expect.any(Boolean),
          isNewWallet: expect.any(Boolean),
        }),
      );
    });

    it('should issue refresh token with correct expiration', async () => {
      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(mockAuthenticationResult);
      jest
        .spyOn(refreshTokenService, 'createRefreshToken')
        .mockResolvedValue({ id: 'token-123' } as any);

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await controller.authenticate(authRequest, undefined, mockReq, response as any);

      expect(refreshTokenService.createRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      );

      // Verify expiration is approximately 7 days in the future
      const callArgs = (refreshTokenService.createRefreshToken as jest.Mock)
        .mock.calls[0][0];
      const expirationTime =
        callArgs.expiresAt.getTime() - new Date().getTime();
      const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
      expect(expirationTime).toBeGreaterThan(sevenDaysInMs - 1000);
      expect(expirationTime).toBeLessThan(sevenDaysInMs + 1000);
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
      jest
        .spyOn(refreshTokenService, 'createRefreshToken')
        .mockResolvedValue({ id: 'token-123' } as any);

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await controller.authenticate(authRequest, undefined, mockReq, response as any);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ isNewUser: true, isNewWallet: true }),
      );
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
      jest
        .spyOn(refreshTokenService, 'createRefreshToken')
        .mockResolvedValue({ id: 'token-123' } as any);

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await controller.authenticate(authRequest, undefined, mockReq, response as any);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ isNewUser: false, isNewWallet: false }),
      );
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
      jest
        .spyOn(refreshTokenService, 'createRefreshToken')
        .mockResolvedValue({ id: 'token-123' } as any);

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await controller.authenticate(minimalRequest, undefined, mockReq, response as any);

      expect(authOrchestrator.handleAuthentication).toHaveBeenCalledWith(
        expect.objectContaining({
          ...minimalRequest,
          idempotencyKey: undefined,
        }),
      );
      expect(response.json).toHaveBeenCalled();
    });

    it('should propagate errors from authOrchestrator', async () => {
      const error = new Error('Authentication failed');
      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockRejectedValue(error);

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await expect(
        controller.authenticate(authRequest, undefined, mockReq, response as any),
      ).rejects.toThrow('Authentication failed');
    });

    it('should fail if refresh token issuance fails (fail-closed)', async () => {
      jest
        .spyOn(authOrchestrator, 'handleAuthentication')
        .mockResolvedValue(mockAuthenticationResult);
      jest
        .spyOn(refreshTokenService, 'createRefreshToken')
        .mockRejectedValue(new Error('Token issuance failed'));

      const response = mockResponse();
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as any;
      await expect(
        controller.authenticate(authRequest, undefined, mockReq, response as any),
      ).rejects.toThrow('Token issuance failed');

      // Verify the response was NOT sent
      expect(response.json).not.toHaveBeenCalled();
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

      const result = await controller.validateAuthentication('invalid-auth-id');

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
      const metadata = Reflect.getMetadata(IS_PUBLIC, controller.authenticate);
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
