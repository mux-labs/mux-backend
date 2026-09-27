import { Test, TestingModule } from '@nestjs/testing';
import { IdempotentUserService } from './idempotent-user.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';

describe('IdempotentUserService', () => {
  let service: IdempotentUserService;
  let mockPrisma: Partial<PrismaService>;
  let mockMetrics: Partial<MetricsService>;

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };

    mockMetrics = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotentUserService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: MetricsService,
          useValue: mockMetrics,
        },
      ],
    }).compile();

    service = moduleFixture.get<IdempotentUserService>(IdempotentUserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findOrCreateUser', () => {
    const mockActorContext = {
      actorId: 'actor-123',
      actorType: 'api_key' as const,
      roles: [],
    };

    it('should reject missing idempotency key', async () => {
      await expect(
        service.findOrCreateUser('auth-id-123', mockActorContext),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid authId', async () => {
      await expect(
        service.findOrCreateUser('', mockActorContext, 'idem-key-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject oversized authId', async () => {
      const oversizedAuthId = 'a'.repeat(257);
      await expect(
        service.findOrCreateUser(oversizedAuthId, mockActorContext, 'idem-key-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should find existing user when authId exists', async () => {
      (mockPrisma.user!.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-123',
        authId: 'auth-id-123',
        email: null,
        displayName: null,
        status: 'ACTIVE',
        authProvider: 'UNKNOWN',
        defaultNetwork: 'TESTNET',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      });

      const result = await service.findOrCreateUser(
        'auth-id-123',
        mockActorContext,
        'idem-key-1',
      );

      expect(result.created).toBe(false);
      expect(result.userId).toBe('user-123');
      expect(result.authId).toBe('auth-id-123');
    });

    it('should create new user when authId does not exist', async () => {
      (mockPrisma.user!.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.user!.create as jest.Mock).mockResolvedValue({
        id: 'user-new-456',
        authId: 'auth-id-new',
        email: null,
        displayName: null,
        status: 'ACTIVE',
        authProvider: 'UNKNOWN',
        defaultNetwork: 'TESTNET',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.findOrCreateUser(
        'auth-id-new',
        mockActorContext,
        'idem-key-2',
      );

      expect(result.created).toBe(true);
      expect(result.userId).toBe('user-new-456');
    });

    it('should handle P2002 race condition by finding existing user', async () => {
      (mockPrisma.user!.findUnique as jest.Mock)
        .mockResolvedValueOnce(null) // First findUnique returns null
        .mockResolvedValueOnce({
          id: 'user-race-789',
          authId: 'auth-id-race',
          email: null,
          displayName: null,
          status: 'ACTIVE',
          authProvider: 'UNKNOWN',
          defaultNetwork: 'TESTNET',
          createdAt: new Date(),
          updatedAt: new Date(),
        }); // Second findUnique (after P2002) returns existing user

      (mockPrisma.user!.create as jest.Mock).mockRejectedValue({
        code: 'P2002',
        message: 'Unique constraint failed',
      });

      const result = await service.findOrCreateUser(
        'auth-id-race',
        mockActorContext,
        'idem-key-3',
      );

      expect(result.created).toBe(false);
      expect(result.userId).toBe('user-race-789');
    });

    it('should reject unauthorized actor types', async () => {
      const unauthorizedContext = {
        actorId: 'actor-123',
        actorType: 'unknown' as const,
        roles: [],
      };

      await expect(
        service.findOrCreateUser('auth-id-123', unauthorizedContext, 'idem-key-4'),
      ).rejects.toThrow(ConflictException);
    });

    it('should return 503 when DB lookup fails', async () => {
      (mockPrisma.user!.findUnique as jest.Mock).mockRejectedValue(
        new Error('DB connection lost'),
      );

      await expect(
        service.findOrCreateUser('auth-id-123', mockActorContext, 'idem-key-5'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
