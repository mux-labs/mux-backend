import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { UserStatus } from '../users/entities/user.entity';

describe('AuthOrchestrator.validateAuthentication', () => {
  let service: AuthOrchestrator;
  let userService: IdempotentUserService;

  beforeEach(async () => {
    const mockUserService = {
      findUserByAuthId: jest.fn(),
      findOrCreateUser: jest.fn(),
      listSessions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthOrchestrator,
        {
          provide: IdempotentUserService,
          useValue: mockUserService,
        },
        {
          provide: 'WalletCreationOrchestrator',
          useValue: {},
        },
        {
          provide: 'IdempotencyService',
          useValue: { getCachedResponse: jest.fn(), cacheResponse: jest.fn() },
        },
        {
          provide: 'AuthMetricsService',
          useValue: { recordAttempt: jest.fn() },
        },
        {
          provide: 'JwtVerificationService',
          useValue: { verifyToken: jest.fn(), extractBearerToken: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<AuthOrchestrator>(AuthOrchestrator);
    userService = module.get<IdempotentUserService>(IdempotentUserService);
  });

  describe('FAILING TEST: Current behavior allows SUSPENDED users to authenticate', () => {
    it('SHOULD FAIL: validateAuthentication returns true for SUSPENDED user', async () => {
      const suspendedUser = {
        id: 'user-123',
        authId: 'suspended-user',
        status: UserStatus.SUSPENDED,
        email: 'suspended@example.com',
      };

      jest
        .spyOn(userService, 'findUserByAuthId')
        .mockResolvedValue(suspendedUser as any);

      const result = await service.validateAuthentication('suspended-user');

      // This is the vulnerability: validateAuthentication currently returns true
      // for ANY user that exists, regardless of status.
      // After fix, this test should fail because the method should reject SUSPENDED users.
      expect(result).toBe(true); // BUG: Should be false for SUSPENDED users
    });

    it('SHOULD FAIL: validateAuthentication returns true for INACTIVE user', async () => {
      const inactiveUser = {
        id: 'user-456',
        authId: 'inactive-user',
        status: UserStatus.INACTIVE,
        email: 'inactive@example.com',
      };

      jest
        .spyOn(userService, 'findUserByAuthId')
        .mockResolvedValue(inactiveUser as any);

      const result = await service.validateAuthentication('inactive-user');

      // Same vulnerability: INACTIVE users should be rejected but currently pass.
      expect(result).toBe(true); // BUG: Should be false for INACTIVE users
    });
  });

  describe('EXPECTED behavior after fix', () => {
    it('should allow ACTIVE users to authenticate', async () => {
      const activeUser = {
        id: 'user-789',
        authId: 'active-user',
        status: UserStatus.ACTIVE,
        email: 'active@example.com',
      };

      jest
        .spyOn(userService, 'findUserByAuthId')
        .mockResolvedValue(activeUser as any);

      const result = await service.validateAuthentication('active-user');

      expect(result).toBe(true);
    });

    it('should reject SUSPENDED users with ForbiddenException', async () => {
      const suspendedUser = {
        id: 'user-123',
        authId: 'suspended-user',
        status: UserStatus.SUSPENDED,
      };

      jest
        .spyOn(userService, 'findUserByAuthId')
        .mockResolvedValue(suspendedUser as any);

      // After fix, this should throw ForbiddenException
      await expect(
        service.validateAuthentication('suspended-user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject INACTIVE users with ForbiddenException', async () => {
      const inactiveUser = {
        id: 'user-456',
        authId: 'inactive-user',
        status: UserStatus.INACTIVE,
      };

      jest
        .spyOn(userService, 'findUserByAuthId')
        .mockResolvedValue(inactiveUser as any);

      // After fix, this should throw ForbiddenException
      await expect(
        service.validateAuthentication('inactive-user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return false on user lookup error', async () => {
      jest
        .spyOn(userService, 'findUserByAuthId')
        .mockRejectedValue(new Error('Database error'));

      const result = await service.validateAuthentication('nonexistent-user');

      expect(result).toBe(false);
    });
  });
});
