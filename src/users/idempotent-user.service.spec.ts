import { Test, TestingModule } from '@nestjs/testing';
import { IdempotentUserService, FindOrCreateUserRequest } from './idempotent-user.service';
import { PrismaClient } from '../generated/prisma/client';

// Mock Prisma Client
const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    delete: jest.fn(),
  },
};

describe('IdempotentUserService', () => {
  let service: IdempotentUserService;
  let prismaClient: jest.Mocked<PrismaClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotentUserService,
        {
          provide: PrismaClient,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<IdempotentUserService>(IdempotentUserService);
    prismaClient = module.get(PrismaClient);

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe('findOrCreateUser', () => {
    const createRequest: FindOrCreateUserRequest = {
      authId: 'auth-123',
      email: 'test@example.com',
      displayName: 'Test User',
      authProvider: 'GOOGLE',
    };

    it('should return existing user when found', async () => {
      // Arrange
      const existingUser = {
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        lastLoginAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };

      mockPrisma.user.findUnique.mockResolvedValue(existingUser);
      mockPrisma.user.update.mockResolvedValue({ ...existingUser, lastLoginAt: new Date() });

      // Act
      const result = await service.findOrCreateUser(createRequest);

      // Assert
      expect(result).toEqual({
        user: expect.objectContaining({
          id: 'user-123',
          authId: 'auth-123',
          email: 'test@example.com',
          displayName: 'Test User',
        }),
        isNewUser: false,
      });

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { authId: 'auth-123' },
      });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: { lastLoginAt: expect.any(Date) },
      });
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('should create new user when not found', async () => {
      // Arrange
      const newUser = {
        id: 'new-user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(newUser);

      // Act
      const result = await service.findOrCreateUser(createRequest);

      // Assert
      expect(result).toEqual({
        user: expect.objectContaining({
          id: 'new-user-123',
          authId: 'auth-123',
          email: 'test@example.com',
          displayName: 'Test User',
          status: 'ACTIVE',
          authProvider: 'GOOGLE',
        }),
        isNewUser: true,
      });

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { authId: 'auth-123' },
      });
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: {
          authId: 'auth-123',
          email: 'test@example.com',
          displayName: 'Test User',
          authProvider: 'GOOGLE',
          lastLoginAt: expect.any(Date),
          status: 'ACTIVE',
        },
      });
    });

    it('should handle race condition gracefully', async () => {
      // Arrange
      const raceConditionError = { code: 'P2002' }; // Prisma unique constraint violation
      const existingUser = {
        id: 'race-user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: 'Test User',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null) // First call - user not found
        .mockResolvedValue(existingUser); // Second call - user found (race condition)
      
      mockPrisma.user.create.mockRejectedValue(raceConditionError);
      mockPrisma.user.update.mockResolvedValue({ ...existingUser, lastLoginAt: new Date() });

      // Act
      const result = await service.findOrCreateUser(createRequest);

      // Assert
      expect(result).toEqual({
        user: expect.objectContaining({
          id: 'race-user-123',
          authId: 'auth-123',
        }),
        isNewUser: false,
      });

      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
      expect(mockPrisma.user.create).toHaveBeenCalled();
    });

    it('should use default authProvider when not provided', async () => {
      // Arrange
      const requestWithoutProvider = {
        authId: 'auth-123',
        email: 'test@example.com',
      };

      const newUser = {
        id: 'new-user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        displayName: null,
        status: 'ACTIVE',
        authProvider: 'UNKNOWN',
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(newUser);

      // Act
      const result = await service.findOrCreateUser(requestWithoutProvider);

      // Assert
      expect(result.user.authProvider).toBe('UNKNOWN');
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          authProvider: 'UNKNOWN',
        }),
      });
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      mockPrisma.user.findUnique.mockRejectedValue(new Error('Database connection failed'));

      // Act & Assert
      await expect(service.findOrCreateUser(createRequest)).rejects.toThrow(
        'User creation failed for authId: auth-123'
      );
    });
  });

  describe('findUserByAuthId', () => {
    it('should return user when found', async () => {
      // Arrange
      const user = {
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(user);

      // Act
      const result = await service.findUserByAuthId('auth-123');

      // Assert
      expect(result).toEqual(expect.objectContaining({
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
      }));
    });

    it('should return null when user not found', async () => {
      // Arrange
      mockPrisma.user.findUnique.mockResolvedValue(null);

      // Act
      const result = await service.findUserByAuthId('nonexistent-auth');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('findUserById', () => {
    it('should return user when found', async () => {
      // Arrange
      const user = {
        id: 'user-123',
        authId: 'auth-123',
        email: 'test@example.com',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(user);

      // Act
      const result = await service.findUserById('user-123');

      // Assert
      expect(result).toEqual(expect.objectContaining({
        id: 'user-123',
        authId: 'auth-123',
      }));
    });

    it('should return null when user not found', async () => {
      // Arrange
      mockPrisma.user.findUnique.mockResolvedValue(null);

      // Act
      const result = await service.findUserById('nonexistent-id');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('updateUser', () => {
    it('should update user successfully', async () => {
      // Arrange
      const updates = {
        email: 'updated@example.com',
        displayName: 'Updated Name',
      };

      const updatedUser = {
        id: 'user-123',
        authId: 'auth-123',
        email: 'updated@example.com',
        displayName: 'Updated Name',
        status: 'ACTIVE',
        authProvider: 'GOOGLE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.update.mockResolvedValue(updatedUser);

      // Act
      const result = await service.updateUser('user-123', updates);

      // Assert
      expect(result).toEqual(expect.objectContaining({
        id: 'user-123',
        email: 'updated@example.com',
        displayName: 'Updated Name',
      }));

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-123' },
        data: updates,
      });
    });
  });

  describe('onModuleInit', () => {
    it('should log initialization message', async () => {
      // Arrange
      const logSpy = jest.spyOn(service['logger'], 'log');

      // Act
      await service.onModuleInit();

      // Assert
      expect(logSpy).toHaveBeenCalledWith('Idempotent User Service initialized');
    });
  });
});
