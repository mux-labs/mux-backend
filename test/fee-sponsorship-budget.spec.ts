import { Test, TestingModule } from '@nestjs/testing';
import { FeeSponsorshipService } from '../src/fee-sponsorship/fee-sponsorship.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MetricsService } from '../src/common/metrics/metrics.service';
import {
  FeeSponsorshipBudgetStatus,
  FeeSponsorshipNetwork,
} from '../src/fee-sponsorship/domain/fee-sponsorship-budget.model';
import {
  CreateFeeSponsorshipBudgetDto,
} from '../src/fee-sponsorship/dto/create-fee-sponsorship-budget.dto';
import {
  UpdateFeeSponsorshipBudgetDto,
} from '../src/fee-sponsorship/dto/update-fee-sponsorship-budget.dto';
import {
  FeeSponsorshipErrorCode,
} from '../src/fee-sponsorship/fee-sponsorship-error-codes';
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';

describe('FeeSponsorshipService', () => {
  let service: FeeSponsorshipService;
  let mockPrisma: Partial<PrismaService>;
  let mockMetrics: Partial<MetricsService>;

  const mockActor = {
    subjectId: 'user-123',
    role: 'owner' as const,
    correlationId: 'corr-123',
  };

  const mockBudgetRecord = {
    id: 'budget-1',
    walletId: 'wallet-1',
    sponsorId: 'sponsor-1',
    limitAmount: '1000000',
    remainingAmount: '1000000',
    assetCode: null,
    assetIssuer: null,
    network: FeeSponsorshipNetwork.TESTNET,
    status: FeeSponsorshipBudgetStatus.ACTIVE,
    note: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
  };

  beforeEach(async () => {
    mockPrisma = {
      feeSponsorshipBudget: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    mockMetrics = {
      incrementCounter: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [
        FeeSponsorshipService,
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

    service = moduleFixture.get<FeeSponsorshipService>(FeeSponsorshipService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createBudget', () => {
    const validDto: CreateFeeSponsorshipBudgetDto = {
      walletId: 'wallet-1',
      sponsorId: 'sponsor-1',
      limitAmount: '1000000',
      network: FeeSponsorshipNetwork.TESTNET,
    };

    it('should create a budget successfully', async () => {
      (mockPrisma.feeSponsorshipBudget!.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.feeSponsorshipBudget!.create as jest.Mock).mockResolvedValue(mockBudgetRecord);

      const result = await service.createBudget(validDto, mockActor);

      expect(result).toBeDefined();
      expect(result.walletId).toBe('wallet-1');
      expect(result.limitAmount).toBe('1000000');
      expect(result.remainingAmount).toBe('1000000');
      expect(result.status).toBe(FeeSponsorshipBudgetStatus.ACTIVE);
    });

    it('should reject when walletId is missing', async () => {
      const dto = { ...validDto, walletId: '' };
      await expect(service.createBudget(dto, mockActor)).rejects.toThrow(BadRequestException);
    });

    it('should reject when sponsorId is missing', async () => {
      const dto = { ...validDto, sponsorId: '' };
      await expect(service.createBudget(dto, mockActor)).rejects.toThrow(BadRequestException);
    });

    it('should reject when limitAmount is not positive', async () => {
      const dto = { ...validDto, limitAmount: '-100' };
      await expect(service.createBudget(dto, mockActor)).rejects.toThrow(BadRequestException);
    });

    it('should reject when a budget already exists for the wallet+network', async () => {
      (mockPrisma.feeSponsorshipBudget!.findFirst as jest.Mock).mockResolvedValue(mockBudgetRecord);

      await expect(service.createBudget(validDto, mockActor)).rejects.toThrow(ConflictException);
    });

    it('should deny mainnet when FEE_SPONSORSHIP_ENABLED is not set', async () => {
      const mainnetDto: CreateFeeSponsorshipBudgetDto = {
        walletId: 'wallet-1',
        sponsorId: 'sponsor-1',
        limitAmount: '1000000',
        network: FeeSponsorshipNetwork.MAINNET,
      };

      await expect(service.createBudget(mainnetDto, mockActor)).rejects.toThrow(ForbiddenException);
    });

    it('should allow mainnet when FEE_SPONSORSHIP_ENABLED is set', async () => {
      process.env.FEE_SPONSORSHIP_ENABLED = 'true';
      (mockPrisma.feeSponsorshipBudget!.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.feeSponsorshipBudget!.create as jest.Mock).mockResolvedValue(mockBudgetRecord);

      const mainnetDto: CreateFeeSponsorshipBudgetDto = {
        walletId: 'wallet-1',
        sponsorId: 'sponsor-1',
        limitAmount: '1000000',
        network: FeeSponsorshipNetwork.MAINNET,
      };

      const result = await service.createBudget(mainnetDto, mockActor);
      expect(result).toBeDefined();

      delete process.env.FEE_SPONSORSHIP_ENABLED;
    });

    it('should reject unauthorized actor roles', async () => {
      const unauthorizedActor = { ...mockActor, role: 'api-key' };
      await expect(
        service.createBudget(validDto, unauthorizedActor),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return 503 on DB dependency failure', async () => {
      (mockPrisma.feeSponsorshipBudget!.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.feeSponsorshipBudget!.create as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientInitializationError('connection refused', 'query'),
      );

      await expect(service.createBudget(validDto, mockActor)).rejects.toThrow(ServiceUnavailableException);
    });

    it('should handle P2002 unique constraint race', async () => {
      (mockPrisma.feeSponsorshipBudget!.findFirst as jest.Mock).mockResolvedValue(null);
      (mockPrisma.feeSponsorshipBudget!.create as jest.Mock).mockRejectedValue({
        code: 'P2002',
        message: 'Unique constraint failed',
      });

      // The service should throw ServiceUnavailableException for DB failures
      await expect(service.createBudget(validDto, mockActor)).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('getBudget', () => {
    it('should return a budget by ID', async () => {
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(mockBudgetRecord);

      const result = await service.getBudget('budget-1', mockActor);

      expect(result).toBeDefined();
      expect(result.id).toBe('budget-1');
    });

    it('should throw NotFoundException for non-existent budget', async () => {
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getBudget('nonexistent', mockActor)).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateBudget', () => {
    it('should update a budget successfully', async () => {
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(mockBudgetRecord);
      (mockPrisma.feeSponsorshipBudget!.update as jest.Mock).mockResolvedValue({
        ...mockBudgetRecord,
        limitAmount: '2000000',
      });

      const dto: UpdateFeeSponsorshipBudgetDto = {
        limitAmount: '2000000',
      };

      const result = await service.updateBudget('budget-1', dto, mockActor);
      expect(result.limitAmount).toBe('2000000');
    });

    it('should throw NotFoundException for non-existent budget', async () => {
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updateBudget('nonexistent', {}, mockActor),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject update to a closed budget', async () => {
      const closedBudget = { ...mockBudgetRecord, status: FeeSponsorshipBudgetStatus.CLOSED };
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(closedBudget);

      await expect(
        service.updateBudget('budget-1', {}, mockActor),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject remainingAmount exceeding limit', async () => {
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(mockBudgetRecord);

      const dto: UpdateFeeSponsorshipBudgetDto = {
        remainingAmount: '9999999',
      };

      await expect(
        service.updateBudget('budget-1', dto, mockActor),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('closeBudget', () => {
    it('should close an active budget', async () => {
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(mockBudgetRecord);
      (mockPrisma.feeSponsorshipBudget!.update as jest.Mock).mockResolvedValue({
        ...mockBudgetRecord,
        status: FeeSponsorshipBudgetStatus.CLOSED,
        remainingAmount: '0',
      });

      const result = await service.closeBudget('budget-1', mockActor);
      expect(result.status).toBe(FeeSponsorshipBudgetStatus.CLOSED);
      expect(result.remainingAmount).toBe('0');
    });

    it('should be idempotent for already-closed budgets', async () => {
      const closedBudget = { ...mockBudgetRecord, status: FeeSponsorshipBudgetStatus.CLOSED };
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(closedBudget);

      const result = await service.closeBudget('budget-1', mockActor);
      expect(result.status).toBe(FeeSponsorshipBudgetStatus.CLOSED);
    });

    it('should throw NotFoundException for non-existent budget', async () => {
      (mockPrisma.feeSponsorshipBudget!.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.closeBudget('nonexistent', mockActor)).rejects.toThrow(NotFoundException);
    });
  });

  describe('listBudgets', () => {
    it('should return budgets for a wallet', async () => {
      (mockPrisma.feeSponsorshipBudget!.findMany as jest.Mock).mockResolvedValue([mockBudgetRecord]);

      const result = await service.listBudgets('wallet-1', mockActor);
      expect(result).toHaveLength(1);
      expect(result[0].walletId).toBe('wallet-1');
    });

    it('should filter by network', async () => {
      (mockPrisma.feeSponsorshipBudget!.findMany as jest.Mock).mockResolvedValue([mockBudgetRecord]);

      const result = await service.listBudgets('wallet-1', mockActor, FeeSponsorshipNetwork.TESTNET);
      expect(result).toHaveLength(1);
    });
  });

  describe('fail-closed on dependency outage', () => {
    it('should return 503 when DB is unavailable for listBudgets', async () => {
      (mockPrisma.feeSponsorshipBudget!.findMany as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientInitializationError('connection refused', 'query'),
      );

      await expect(service.listBudgets('wallet-1', mockActor)).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
