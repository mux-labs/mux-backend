import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { LimitPeriod } from './dto/create-limit.dto';

const mockLimit = {
  id: 'uuid-limit-1',
  userId: 'uuid-user-1',
  perTransactionLimit: 100,
  periodLimit: 500,
  period: LimitPeriod.DAILY,
  assetCode: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('LimitsController', () => {
  let controller: LimitsController;
  let service: jest.Mocked<LimitsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LimitsController],
      providers: [
        {
          provide: LimitsService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            findByUser: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<LimitsController>(LimitsController);
    service = module.get(LimitsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('delegates to service.create', async () => {
      service.create.mockResolvedValue(mockLimit as any);
      const dto = { userId: 'uuid-user-1', perTransactionLimit: 100, periodLimit: 500 };
      const result = await controller.create(dto as any);
      expect(service.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockLimit);
    });
  });

  describe('findAll', () => {
    it('delegates to service.findAll', async () => {
      service.findAll.mockResolvedValue([mockLimit] as any);
      const result = await controller.findAll();
      expect(result).toEqual([mockLimit]);
    });
  });

  describe('findByUser', () => {
    it('delegates to service.findByUser', async () => {
      service.findByUser.mockResolvedValue([mockLimit] as any);
      const result = await controller.findByUser('uuid-user-1');
      expect(service.findByUser).toHaveBeenCalledWith('uuid-user-1');
      expect(result).toEqual([mockLimit]);
    });
  });

  describe('findOne', () => {
    it('delegates to service.findOne', async () => {
      service.findOne.mockResolvedValue(mockLimit as any);
      const result = await controller.findOne('uuid-limit-1');
      expect(service.findOne).toHaveBeenCalledWith('uuid-limit-1');
      expect(result).toEqual(mockLimit);
    });

    it('propagates NotFoundException from service', async () => {
      service.findOne.mockRejectedValue(new NotFoundException());
      await expect(controller.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('delegates to service.update', async () => {
      const updated = { ...mockLimit, periodLimit: 1000 };
      service.update.mockResolvedValue(updated as any);
      const result = await controller.update('uuid-limit-1', { periodLimit: 1000 });
      expect(service.update).toHaveBeenCalledWith('uuid-limit-1', { periodLimit: 1000 });
      expect(result).toEqual(updated);
    });
  });

  describe('remove', () => {
    it('delegates to service.remove', async () => {
      service.remove.mockResolvedValue(mockLimit as any);
      const result = await controller.remove('uuid-limit-1');
      expect(service.remove).toHaveBeenCalledWith('uuid-limit-1');
      expect(result).toEqual(mockLimit);
    });
  });
});
