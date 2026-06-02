import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let service: jest.Mocked<PaymentsService>;

  const mockService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: mockService }],
    }).compile();

    controller = module.get<PaymentsController>(PaymentsController);
    service = module.get(PaymentsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should call service.create with dto and return result', async () => {
      const dto = { fromId: 1, toId: 2, amount: 50, currency: 'USD', description: 'test' };
      const created = { id: 1, status: 'PENDING', ...dto };
      mockService.create.mockResolvedValue(created);

      const result = await controller.create(dto as any);

      expect(service.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(created);
    });

    it('should propagate error when service throws', async () => {
      mockService.create.mockRejectedValue(new Error('Limit exceeded'));
      await expect(controller.create({} as any)).rejects.toThrow('Limit exceeded');
    });
  });

  describe('findAll', () => {
    it('should return all payments', async () => {
      const payments = [{ id: 1 }, { id: 2 }];
      mockService.findAll.mockResolvedValue(payments);

      const result = await controller.findAll();
      expect(result).toEqual(payments);
    });
  });

  describe('findOne', () => {
    it('should return payment by id', async () => {
      const payment = { id: 5, amount: 100 };
      mockService.findOne.mockResolvedValue(payment);

      const result = await controller.findOne('5');
      expect(service.findOne).toHaveBeenCalledWith(5);
      expect(result).toEqual(payment);
    });
  });

  describe('update', () => {
    it('should call service.update with parsed id and dto', () => {
      mockService.update.mockReturnValue('updated #3');
      const result = controller.update('3', {} as any);
      expect(service.update).toHaveBeenCalledWith(3, {});
      expect(result).toBe('updated #3');
    });
  });

  describe('remove', () => {
    it('should call service.remove with parsed id', () => {
      mockService.remove.mockReturnValue('removed #4');
      const result = controller.remove('4');
      expect(service.remove).toHaveBeenCalledWith(4);
      expect(result).toBe('removed #4');
    });
  });
});
