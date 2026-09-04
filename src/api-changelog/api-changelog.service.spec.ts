import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiChangelogService } from './api-changelog.service';
import { CreateApiChangelogDto } from './dto/create-api-changelog.dto';
import { ChangeType, ChangeCategory } from './domain/api-changelog.model';

describe('ApiChangelogService', () => {
  let service: ApiChangelogService;
  let mockPrismaClient: any;

  beforeEach(async () => {
    mockPrismaClient = {
      apiChangelog: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      $disconnect: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiChangelogService],
    }).compile();

    service = module.get<ApiChangelogService>(ApiChangelogService);
    (service as any).prisma = mockPrismaClient;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a changelog entry with valid input', async () => {
      const dto: CreateApiChangelogDto = {
        version: '1.2.0',
        changeType: ChangeType.ADDED,
        category: ChangeCategory.WALLETS,
        title: 'Add timestamps to wallets',
        description: 'Wallet API now returns createdAt and updatedAt',
        affectedEndpoints: ['GET /wallets', 'POST /wallets'],
      };

      const mockEntry = {
        id: '123',
        ...dto,
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaClient.apiChangelog.create.mockResolvedValue(mockEntry);

      const result = await service.create(dto);

      expect(result.id).toBe('123');
      expect(result.version).toBe('1.2.0');
      expect(mockPrismaClient.apiChangelog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          version: '1.2.0',
          changeType: ChangeType.ADDED,
        }),
      });
    });

    it('should reject invalid version format', async () => {
      const dto: CreateApiChangelogDto = {
        version: 'invalid-version',
        changeType: ChangeType.ADDED,
        category: ChangeCategory.WALLETS,
        title: 'Test',
        description: 'Test',
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('should return paginated changelog entries', async () => {
      const mockEntries = [
        {
          id: '1',
          version: '1.2.0',
          changeType: ChangeType.ADDED,
          category: ChangeCategory.WALLETS,
          title: 'Test',
          description: 'Test',
          publishedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaClient.apiChangelog.findMany.mockResolvedValue(mockEntries);
      mockPrismaClient.apiChangelog.count.mockResolvedValue(1);

      const result = await service.findAll({ limit: 20, offset: 0 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockPrismaClient.apiChangelog.findMany).toHaveBeenCalled();
    });

    it('should filter by version', async () => {
      mockPrismaClient.apiChangelog.findMany.mockResolvedValue([]);
      mockPrismaClient.apiChangelog.count.mockResolvedValue(0);

      await service.findAll({ version: '1.2.0' });

      expect(mockPrismaClient.apiChangelog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ version: '1.2.0' }),
        }),
      );
    });
  });

  describe('findOne', () => {
    it('should return a changelog entry by ID', async () => {
      const mockEntry = {
        id: '123',
        version: '1.2.0',
        changeType: ChangeType.ADDED,
        category: ChangeCategory.WALLETS,
        title: 'Test',
        description: 'Test',
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaClient.apiChangelog.findUnique.mockResolvedValue(mockEntry);

      const result = await service.findOne('123');

      expect(result.id).toBe('123');
      expect(mockPrismaClient.apiChangelog.findUnique).toHaveBeenCalledWith({
        where: { id: '123' },
      });
    });

    it('should throw NotFoundException if entry does not exist', async () => {
      mockPrismaClient.apiChangelog.findUnique.mockResolvedValue(null);

      await expect(service.findOne('999')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update a changelog entry', async () => {
      const mockEntry = {
        id: '123',
        version: '1.2.0',
        changeType: ChangeType.ADDED,
        category: ChangeCategory.WALLETS,
        title: 'Updated title',
        description: 'Test',
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaClient.apiChangelog.findUnique.mockResolvedValue(mockEntry);
      mockPrismaClient.apiChangelog.update.mockResolvedValue(mockEntry);

      const result = await service.update('123', { title: 'Updated title' });

      expect(result.title).toBe('Updated title');
      expect(mockPrismaClient.apiChangelog.update).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete a changelog entry', async () => {
      const mockEntry = {
        id: '123',
        version: '1.2.0',
      };

      mockPrismaClient.apiChangelog.findUnique.mockResolvedValue(mockEntry);
      mockPrismaClient.apiChangelog.delete.mockResolvedValue(mockEntry);

      await service.delete('123');

      expect(mockPrismaClient.apiChangelog.delete).toHaveBeenCalledWith({
        where: { id: '123' },
      });
    });
  });
});
