import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LimitsController } from './limits.controller';
import { LimitsService } from './limits.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { LimitPeriod } from './dto/create-limit.dto';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

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
    })
      .overrideGuard(FeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .compile();

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

  describe('swagger decorators', () => {
    it('should have @ApiResponse decorators on all routes', () => {
      const routes = ['setLimits', 'getLimits', 'removeLimits'];

      routes.forEach((route) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          LimitsController.prototype,
          route,
        );
        expect(descriptor).toBeDefined();

        const metadata = Reflect.getMetadata('swagger/apiResponse', descriptor.value);
        expect(metadata).toBeDefined();
      });
    });

    it('should have @ApiOperation on all routes', () => {
      const routes = ['setLimits', 'getLimits', 'removeLimits'];

      routes.forEach((route) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          LimitsController.prototype,
          route,
        );
        expect(descriptor).toBeDefined();

        const metadata = Reflect.getMetadata('swagger/apiOperation', descriptor.value);
        expect(metadata).toBeDefined();
      });
    });
  });
});
