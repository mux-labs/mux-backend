import { Test, TestingModule } from '@nestjs/testing';
import { RecoveryController } from './recovery.controller';
import { RecoveryService } from './recovery.service';
import { RecoveryStatus } from './domain/recovery.model';
import { BadRequestException } from '@nestjs/common';
import { AdminRecoveryService } from './admin-recovery.service';

describe('RecoveryController', () => {
  let controller: RecoveryController;
  let service: any;

  const mockRecovery = {
    id: '660e8400-e29b-41d4-a716-446655440001',
    walletId: '550e8400-e29b-41d4-a716-446655440000',
    requester: 'user_abc123',
    status: RecoveryStatus.PENDING,
    metadata: null,
    createdAt: new Date('2026-06-29T12:00:00.000Z'),
    updatedAt: new Date('2026-06-29T12:00:00.000Z'),
  };

  const mockPaginatedResponse = {
    data: [mockRecovery],
    total: 1,
    limit: 20,
    offset: 0,
    hasMore: false,
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      initiate: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RecoveryController],
      providers: [
        {
          provide: RecoveryService,
          useValue: service,
        },
        { provide: AdminRecoveryService, useValue: {} },
      ],
    }).compile();

    controller = module.get<RecoveryController>(RecoveryController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should call service.create', async () => {
      const dto = {
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc123',
      };
      service.create.mockResolvedValue(mockRecovery);

      const result = await controller.create(dto);

      expect(service.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockRecovery);
    });
  });

  describe('findAll', () => {
    it('should call service.findAll with filters and pagination', async () => {
      service.findAll.mockResolvedValue(mockPaginatedResponse);

      const result = await controller.findAll(
        '550e8400-e29b-41d4-a716-446655440000',
        'user_abc',
        RecoveryStatus.PENDING,
        '10',
        '0',
      );

      expect(service.findAll).toHaveBeenCalledWith({
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        requester: 'user_abc',
        status: RecoveryStatus.PENDING,
        limit: 10,
        offset: 0,
      });
      expect(result).toEqual(mockPaginatedResponse);
    });

    it('should pass undefined when query params are omitted', async () => {
      service.findAll.mockResolvedValue(mockPaginatedResponse);

      const result = await controller.findAll();

      expect(service.findAll).toHaveBeenCalledWith({
        walletId: undefined,
        requester: undefined,
        status: undefined,
        limit: undefined,
        offset: undefined,
      });
      expect(result).toEqual(mockPaginatedResponse);
    });

    it('should throw on invalid limit', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, '101', undefined),
      ).toThrow(BadRequestException);
    });

    it('should throw on negative limit', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, '-1', undefined),
      ).toThrow(BadRequestException);
    });

    it('should throw on non-integer offset', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, undefined, 'abc'),
      ).toThrow(BadRequestException);
    });

    it('should pass createdAt filter when dates provided', async () => {
      service.findAll.mockResolvedValue(mockPaginatedResponse);

      const result = await controller.findAll(
        undefined, undefined, undefined, undefined, undefined,
        '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z',
      );

      expect(service.findAll).toHaveBeenCalledWith({
        walletId: undefined,
        requester: undefined,
        status: undefined,
        limit: undefined,
        offset: undefined,
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-12-31T23:59:59.999Z'),
        },
      });
      expect(result).toEqual(mockPaginatedResponse);
    });

    it('should throw on invalid createdAtFrom date', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, undefined, undefined, 'not-a-date', undefined),
      ).toThrow(BadRequestException);
    });

    it('should throw on invalid createdAtTo date', () => {
      expect(() =>
        controller.findAll(undefined, undefined, undefined, undefined, undefined, undefined, 'bad-date'),
      ).toThrow(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('should call service.findOne', async () => {
      service.findOne.mockResolvedValue(mockRecovery);

      const result = await controller.findOne('660e8400-e29b-41d4-a716-446655440001');

      expect(service.findOne).toHaveBeenCalledWith('660e8400-e29b-41d4-a716-446655440001');
      expect(result).toEqual(mockRecovery);
    });
  });

  describe('update', () => {
    it('should call service.update', async () => {
      const dto = { status: RecoveryStatus.IN_REVIEW };
      service.update.mockResolvedValue({
        ...mockRecovery,
        status: RecoveryStatus.IN_REVIEW,
      });

      const result = await controller.update(
        '660e8400-e29b-41d4-a716-446655440001',
        dto,
      );

      expect(service.update).toHaveBeenCalledWith(
        '660e8400-e29b-41d4-a716-446655440001',
        dto,
      );
      expect(result.status).toEqual(RecoveryStatus.IN_REVIEW);
    });
  });

  describe('initiate', () => {
    it('should call service.initiate', async () => {
      service.initiate.mockResolvedValue({
        ...mockRecovery,
        status: RecoveryStatus.IN_REVIEW,
      });

      const result = await controller.initiate(
        '660e8400-e29b-41d4-a716-446655440001',
      );

      expect(service.initiate).toHaveBeenCalledWith(
        '660e8400-e29b-41d4-a716-446655440001',
      );
      expect(result.status).toEqual(RecoveryStatus.IN_REVIEW);
    });
  });

  describe('remove', () => {
    it('should call service.remove and return message', async () => {
      service.remove.mockResolvedValue(undefined);

      const result = await controller.remove('660e8400-e29b-41d4-a716-446655440001');

      expect(service.remove).toHaveBeenCalledWith('660e8400-e29b-41d4-a716-446655440001');
      expect(result).toEqual({ message: 'Recovery request deleted successfully' });
    });
  });
});
