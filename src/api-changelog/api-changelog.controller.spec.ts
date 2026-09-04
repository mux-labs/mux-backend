import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { ApiChangelogController } from './api-changelog.controller';
import { ApiChangelogService } from './api-changelog.service';
import { CreateApiChangelogDto } from './dto/create-api-changelog.dto';
import { ChangeType, ChangeCategory } from './domain/api-changelog.model';

describe('ApiChangelogController', () => {
  let controller: ApiChangelogController;
  let service: ApiChangelogService;

  const mockChangelogEntry = {
    id: '123',
    version: '1.2.0',
    changeType: ChangeType.ADDED,
    category: ChangeCategory.WALLETS,
    title: 'Add timestamps to wallets',
    description: 'Wallet API now returns createdAt and updatedAt',
    affectedEndpoints: ['GET /wallets', 'POST /wallets'],
    migrationGuide: null,
    publishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiChangelogController],
      providers: [
        {
          provide: ApiChangelogService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ApiChangelogController>(ApiChangelogController);
    service = module.get<ApiChangelogService>(ApiChangelogService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a changelog entry', async () => {
      const dto: CreateApiChangelogDto = {
        version: '1.2.0',
        changeType: ChangeType.ADDED,
        category: ChangeCategory.WALLETS,
        title: 'Add timestamps to wallets',
        description: 'Wallet API now returns createdAt and updatedAt',
      };

      jest.spyOn(service, 'create').mockResolvedValue(mockChangelogEntry);

      const result = await controller.create(dto);

      expect(result.id).toBe('123');
      expect(result.version).toBe('1.2.0');
      expect(service.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('findAll', () => {
    it('should return paginated changelog entries', async () => {
      const mockResult = {
        data: [mockChangelogEntry],
        total: 1,
      };

      jest.spyOn(service, 'findAll').mockResolvedValue(mockResult);

      const result = await controller.findAll(
        undefined,
        undefined,
        '20',
        '0',
      );

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(service.findAll).toHaveBeenCalledWith({
        version: undefined,
        category: undefined,
        limit: 20,
        offset: 0,
      });
    });

    it('should support filtering by version and category', async () => {
      const mockResult = {
        data: [mockChangelogEntry],
        total: 1,
      };

      jest.spyOn(service, 'findAll').mockResolvedValue(mockResult);

      await controller.findAll('1.2.0', 'WALLETS', '20', '0');

      expect(service.findAll).toHaveBeenCalledWith({
        version: '1.2.0',
        category: 'WALLETS',
        limit: 20,
        offset: 0,
      });
    });
  });

  describe('findOne', () => {
    it('should return a specific changelog entry', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue(mockChangelogEntry);

      const result = await controller.findOne('123');

      expect(result.id).toBe('123');
      expect(service.findOne).toHaveBeenCalledWith('123');
    });
  });

  describe('update', () => {
    it('should update a changelog entry', async () => {
      const updateDto = {
        title: 'Updated title',
      };

      jest.spyOn(service, 'update').mockResolvedValue(mockChangelogEntry);

      const result = await controller.update('123', updateDto);

      expect(result.id).toBe('123');
      expect(service.update).toHaveBeenCalledWith('123', updateDto);
    });
  });

  describe('delete', () => {
    it('should delete a changelog entry', async () => {
      jest.spyOn(service, 'delete').mockResolvedValue(undefined);

      await controller.delete('123');

      expect(service.delete).toHaveBeenCalledWith('123');
    });
  });
});
