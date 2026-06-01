import { Test, TestingModule } from '@nestjs/testing';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';

describe('LimitsController', () => {
  let controller: LimitsController;
  let limitsService: any;

  const walletId = 'wallet-uuid-1';

  beforeEach(async () => {
    limitsService = {
      setLimits: jest.fn(),
      getLimits: jest.fn(),
      removeLimits: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LimitsController],
      providers: [{ provide: LimitsService, useValue: limitsService }],
    }).compile();

    controller = module.get<LimitsController>(LimitsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('setLimits should delegate to service', async () => {
    const dto = { dailyLimit: 500, perTransactionLimit: 100 };
    await controller.setLimits(walletId, dto as any);
    expect(limitsService.setLimits).toHaveBeenCalledWith(walletId, 500, 100);
  });

  it('getLimits should delegate to service', async () => {
    await controller.getLimits(walletId);
    expect(limitsService.getLimits).toHaveBeenCalledWith(walletId);
  });

  it('removeLimits should delegate to service', async () => {
    await controller.removeLimits(walletId);
    expect(limitsService.removeLimits).toHaveBeenCalledWith(walletId);
  });
});
