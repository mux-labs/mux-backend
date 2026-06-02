import { Test, TestingModule } from '@nestjs/testing';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';

describe('LimitsController', () => {
  let controller: LimitsController;
  let service: jest.Mocked<LimitsService>;

  const mockService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    setLimits: jest.fn(),
    getLimits: jest.fn(),
    checkLimits: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LimitsController],
      providers: [{ provide: LimitsService, useValue: mockService }],
    }).compile();

    controller = module.get<LimitsController>(LimitsController);
    service = module.get(LimitsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should delegate to service.create', () => {
      mockService.create.mockReturnValue('new limit');
      const result = controller.create({} as any);
      expect(service.create).toHaveBeenCalled();
      expect(result).toBe('new limit');
    });
  });

  describe('findAll', () => {
    it('should return all limits', () => {
      mockService.findAll.mockReturnValue('all limits');
      expect(controller.findAll()).toBe('all limits');
    });
  });

  describe('findOne', () => {
    it('should return limit by id', () => {
      mockService.findOne.mockReturnValue('limit #7');
      const result = controller.findOne('7');
      expect(service.findOne).toHaveBeenCalledWith(7);
      expect(result).toBe('limit #7');
    });
  });

  describe('update', () => {
    it('should call service.update with parsed id', () => {
      mockService.update.mockReturnValue('updated #2');
      const result = controller.update('2', {} as any);
      expect(service.update).toHaveBeenCalledWith(2, {});
      expect(result).toBe('updated #2');
    });
  });

  describe('remove', () => {
    it('should call service.remove with parsed id', () => {
      mockService.remove.mockReturnValue('removed #9');
      const result = controller.remove('9');
      expect(service.remove).toHaveBeenCalledWith(9);
      expect(result).toBe('removed #9');
    });
  });
});
